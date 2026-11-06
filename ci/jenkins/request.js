// Emit the shared dispatcher's typed request. This command never submits a build.
const args = process.argv.slice(2);
const usage = 'Use --branch <approved-branch> --source-sha <40-hex-commit> --lane check.';
const values = new Map();
let valid = args.length === 6;
for (let index = 0; index < args.length; index += 2) {
	const key = args[index], value = args[index + 1];
	if (!['--branch', '--source-sha', '--lane'].includes(key) || values.has(key) || typeof value !== 'string') {
		valid = false;
	}
	values.set(key, value);
}
const branch = values.get('--branch');
valid = valid && typeof branch === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(branch)
	&& branch.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.')
		&& !part.endsWith('.lock') && !part.includes('..'))
	&& /^[0-9a-f]{40}$/.test(values.get('--source-sha') || '') && values.get('--lane') === 'check';
if (!valid) {
	process.stderr.write(JSON.stringify({ status: 'blocked', code: 'invalid_dispatch_arguments', message: usage }) + '\n');
	process.exitCode = 1;
} else {
	process.stdout.write(JSON.stringify({ version: 1,
		repository: 'https://github.com/rankupgames/unity-cursor-toolkit.git',
		branch, sourceSha: values.get('--source-sha'), lane: 'check' }) + '\n');
}
