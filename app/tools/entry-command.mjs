// Verification-only invocation of a Windows batch entry. Keep arguments separate;
// reject shell metacharacters rather than interpreting arbitrary command text.
export function entryCommand(entry, args, platform = process.platform) {
  if (platform !== 'win32') return { file: entry.path, args: [...entry.args, ...args], options: {} };
  const values = [entry.path, ...entry.args, ...args];
  if (values.some(value => /[\r\n&|<>%^!]/.test(value))) throw Error('Unsupported shell character in verification arguments');
  const quote = value => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, value => value + value) + '"';
  const encoded = values.map(quote);
  encoded[0] = '"' + encoded[0]; encoded[encoded.length - 1] += '"';
  return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', ...encoded], options: { windowsVerbatimArguments: true } };
}
