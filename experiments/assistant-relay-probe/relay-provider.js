// Private RUG-535 provider. No shipping server or public toolkit API changes.
const { spawn } = require('child_process');
const policy = require('./tool-policy.json');
class RelayError extends Error {
	constructor(code, message) { super(message); this.code = code; }
}
class RelayClient {
	constructor(executable, args, options = {}) {
		this.requests = []; this.messages = []; this.pending = new Map(); this.sequence = 0;
		this.buffer = ''; this.stderr = ''; this.timeout = options.timeout || 10000;
		this.child = spawn(executable, args, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
		this.child.stdin.on('error', error => this.fail(new RelayError('relay_write_failed', error.message)));
		this.child.stderr.on('data', bytes => { this.stderr += bytes.toString(); });
		this.child.stdout.on('data', bytes => this.receive(bytes.toString()));
		this.child.once('error', error => this.fail(new RelayError('relay_start_failed', error.message)));
		this.child.once('exit', (code, signal) => {
			this.exit = { code, signal };
			this.fail(new RelayError(this.stopping ? 'relay_stopped' : 'relay_unexpected_exit', 'Relay exited: ' + code + '/' + signal));
		});
	}
	fail(error) {
		this.failure = error;
		for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
		this.pending.clear();
	}
	receive(text) {
		this.buffer += text;
		while (this.buffer.includes('\n')) {
			const end = this.buffer.indexOf('\n'), line = this.buffer.slice(0, end).trim();
			this.buffer = this.buffer.slice(end + 1);
			if (!line) continue;
			let message;
			try { message = JSON.parse(line); }
			catch { this.fail(new RelayError('relay_protocol_error', 'Relay stdout is not newline JSON-RPC.')); return; }
			this.messages.push({ direction: 'receive', at: new Date().toISOString(), message });
			const item = this.pending.get(message.id);
			if (!item) continue;
			this.pending.delete(message.id); clearTimeout(item.timer);
			if (message.error) item.reject(new RelayError('relay_rpc_error', JSON.stringify(message.error)));
			else if (!Object.hasOwn(message, 'result')) item.reject(new RelayError('relay_protocol_error', 'Missing JSON-RPC result.'));
			else item.resolve(message.result);
		}
	}
	request(method, params = {}) {
		if (this.failure) return Promise.reject(this.failure);
		const message = { jsonrpc: '2.0', id: ++this.sequence, method, params };
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(message.id);
				const error = new RelayError('relay_timeout', method + ' exceeded ' + this.timeout + 'ms.');
				this.fail(error); reject(error);
			}, this.timeout);
			this.pending.set(message.id, { resolve, reject, timer });
			this.write(message);
		});
	}
	write(message) {
		if (this.failure) throw this.failure;
		this.requests.push(message);
		this.messages.push({ direction: 'send', at: new Date().toISOString(), message });
		this.child.stdin.write(JSON.stringify(message) + '\n');
	}
	async catalog() {
		await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'uct-private-assistant-probe', version: '1.0' } });
		this.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
		const result = await this.request('tools/list');
		if (!result || !Array.isArray(result.tools) || !result.tools.length)
			throw new RelayError('relay_empty_catalog', 'Assistant returned no tools.');
		return result.tools;
	}
	async close() {
		this.stopping = true;
		this.child.stdin.end();
		const deadline = Date.now() + 5000;
		while (!this.exit && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
		return { exited: !!this.exit, ...this.exit };
	}
}
function refusal(code, message) {
	return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code, message }, origin: { source: 'assistantRelay', packageVersion: policy.packageVersion } }) }] };
}
function provider(client, catalog, readOnly = true) {
	const selected = policy.tools.map(item => {
		const actual = catalog.find(tool => tool.name === item.name);
		if (!actual) throw new RelayError('relay_schema_missing', 'Missing selected tool: ' + item.name);
		if (item.name === 'Unity_ReadConsole' && !actual.inputSchema?.properties?.Action)
			throw new RelayError('relay_schema_mismatch', 'Expected exact Action property.');
		return { ...actual, name: 'assistantRelay/' + item.name, _meta: { origin: 'assistantRelay', packageVersion: policy.packageVersion },
			annotations: { readOnlyHint: false, destructiveHint: item.category === 'policy-escape', openWorldHint: true } };
	});
	return {
		toolGroupName: 'assistantRelay',
		getTools: () => selected,
		async handleToolCall(name, args) {
			const item = policy.tools.find(entry => 'assistantRelay/' + entry.name === name);
			if (!item) return refusal('relay_unclassified', 'Tool has no committed classification.');
			if (item.category === 'policy-escape') return refusal('relay_policy_escape', 'Arbitrary C# execution is refused, including dryRun.');
			const schema = selected.find(tool => tool.name === name).inputSchema;
			if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !Object.hasOwn(schema.properties, key)))
				return refusal('relay_argument_unclassified', 'Only exact captured schema keys are accepted.');
			const action = Object.hasOwn(args, 'Action') ? args.Action : undefined;
			const category = typeof action === 'string' ? item.actions?.[action] : undefined;
			if (!category) return refusal('relay_unclassified_action', 'An exact classified Action is required.');
			if (readOnly && category !== 'read-only') return refusal('relay_read_only', 'Read-only mode blocks this action.');
			if (category !== 'read-only') return refusal('relay_spike_scope', 'This private spike only forwards reads.');
			try {
				const result = await client.request('tools/call', { name: item.name, arguments: args });
				return { isError: result.isError === true, content: [{ type: 'text', text: JSON.stringify({
					origin: { source: 'assistantRelay', packageVersion: policy.packageVersion }, result
				}) }] };
			} catch (error) { return refusal(error.code || 'relay_failed', error.message); }
		}
	};
}
function requireEditorVersion(version) {
	const match = /^(\d+)\.(\d+)\.(\d+)([abfp])(\d+)$/.exec(version);
	if (!match || Number(match[1]) < 6000 || Number(match[1]) === 6000 && Number(match[2]) === 0 &&
		(Number(match[3]) < 60 || Number(match[3]) === 60 && (match[4] !== 'f' || Number(match[5]) < 1)))
		throw new RelayError('relay_editor_unsupported', 'Assistant requires Unity6000.0.60f1 or later.');
}
module.exports = { RelayClient, RelayError, provider, requireEditorVersion };
