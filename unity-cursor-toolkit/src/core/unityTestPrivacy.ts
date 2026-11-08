import * as os from 'os';
const escapeRegex = (value: string): string => value.replace(/[$.*+?^{}()|[\]\\]/g, '\\$&');

export function redactUnityTestText(text: string, projectPath: string): string {
	let safe = text;
	const roots = [projectPath, os.homedir(), os.tmpdir(), process.env.USERPROFILE, process.env.HOME, process.env.APPDATA, process.env.LOCALAPPDATA].filter((v): v is string => !!v);
	for (const root of roots.sort((a, b) => b.length - a.length)) {
		for (const form of [root, root.replace(/\\/g, '/'), root.replace(/\//g, '\\')]) {
			safe = safe.replace(new RegExp(escapeRegex(form), process.platform === 'win32' ? 'gi' : 'g'), root === projectPath ? '<project>' : '<private-path>');
		}
	}
	for (const [key, value] of Object.entries(process.env)) {
		if (value && value.length >= 4 && /token|secret|password|credential|api.?key/i.test(key)) { safe = safe.split(value).join('<redacted>'); }
	}
	return safe.replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer <redacted>')
		.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<redacted>')
		.replace(/((?:token|secret|password|credential|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;<>]+/gi, '$1<redacted>')
		.replace(/[A-Za-z]:[\\/][^\r\n"'<>]*/g, '<absolute-path>')
		.replace(/(^|[\s("'=])\/(?!\/)[^\s"'<>]+/g, '$1<absolute-path>');
}
