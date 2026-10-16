// Decides whether an agent's tool call is risky enough to ask the user first,
// in the spirit of Codex approvals: work inside the agent's folder runs freely;
// destructive, system-wide or out-of-folder actions need a human OK.

const path = require('path');

const COMMAND_RULES = [
  [/\brm\s+(-[a-z]*r[a-z]*\b|--recursive)|\brm\s+-[a-z]*f/i, 'Deletes files (recursive or forced)'],
  [/(^|[\s;&|(])(rm|rmdir|rd|del|erase|unlink|shred)(\s|$)/i, 'Deletes files'],
  [/\b(Remove-Item|ri)\b/i, 'Deletes files'],
  [/\b(Clear-RecycleBin|Clear-Content)\b|vssadmin|wevtutil\s+cl/i, 'Permanently clears data'],
  [/\b(format(\.com)?\s+[a-z]:|diskpart|mkfs|fdisk|bcdedit|Format-Volume|Clear-Disk|Initialize-Disk)\b|cipher\s+\/w|\bdd\s+if=/i, 'Changes disks or boot settings'],
  [/\b(shutdown|Restart-Computer|Stop-Computer|reboot|poweroff|logoff)\b/i, 'Shuts down or restarts the PC'],
  [/\breg(\.exe)?\s+(add|delete|import|load|unload)\b|HKLM:|HKCU:|HKEY_|\b(Set|New|Remove)-ItemProperty\b/i, 'Changes the Windows registry'],
  [/\bgit\s+push\b/i, 'Pushes to a remote repository'],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|checkout\s+\.|restore\s|branch\s+-D|stash\s+(drop|clear)|filter-branch|rebase)\b/i, 'Can throw away git work'],
  [/(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*\|\s*(sh|bash|zsh|iex|Invoke-Expression|powershell|pwsh|python)\b/i, 'Runs a script downloaded from the internet'],
  [/\b(iex|Invoke-Expression)\b|-EncodedCommand\b|\bpowershell(\.exe)?\s+-e(nc)?\b/i, 'Runs dynamically generated code'],
  [/\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bdocker\s+push\b|\bgh\s+(release|repo\s+delete|pr\s+merge)\b/i, 'Publishes or changes something online'],
  [/\b(kill|pkill|killall|taskkill|Stop-Process|Stop-Service)\b/i, 'Stops running programs or services'],
  [/\b(sudo|runas|gsudo)\b|-Verb\s+RunAs/i, 'Runs with administrator rights'],
  [/\bSet-ExecutionPolicy\b|\bnet\s+(user|localgroup|share)\b|\bschtasks\b|\bsc(\.exe)?\s+(create|delete|config|stop)\b|\b(New|Remove|Set)-Service\b|Register-ScheduledTask|\bnetsh\b|Set-NetFirewall|Disable-WindowsOptionalFeature|\bsetx\b|\[Environment\]::SetEnvironmentVariable/i, 'Changes system settings'],
  [/\bchmod\s+(-R|777)|\bchown\b|\bicacls\b|\btakeown\b|\battrib\s/i, 'Changes file permissions'],
  [/\b(drop\s+(table|database|schema)|truncate\s+table|delete\s+from)\b/i, 'Deletes database data'],
  [/\b(winget|choco|scoop)\s+(install|uninstall|upgrade)\b|\bmsiexec\b|\bpip\s+uninstall\b|\bnpm\s+(uninstall|i|install)\s+-g\b/i, 'Installs or removes software'],
];

const WRITE_VERBS = /(^|[\s;&|(])(mv|move|cp|copy|xcopy|robocopy|Move-Item|Copy-Item|Rename-Item|ren|New-Item|ni|mkdir|md|Set-Content|Add-Content|Out-File|tee|touch|echo\s.*>|>>?)(\s|$)/i;

const SENSITIVE = [
  [/[\\/]\.ssh([\\/]|$)|id_rsa|id_ed25519|\.pem\b|\.pfx\b|\.key\b/i, 'Touches SSH keys or certificates'],
  [/(^|[\\/])\.env(\.|$|[\\/])|\.git-credentials|\.npmrc|\.aws[\\/]|\.azure[\\/]|\.kube[\\/]|credentials|secrets?\.(json|ya?ml|txt)|\.claude[\\/]\.credentials/i, 'Touches secrets or credentials'],
  [/(Chrome|Edge|Firefox|Brave|Opera)[^\n]*[\\/](User Data|Profiles)|Login Data|Cookies/i, 'Touches browser profile data'],
  [/^[a-z]:\\windows(\\|$)|\\System32\\|^[a-z]:\\Program Files|^[a-z]:\\ProgramData|^\/(etc|usr|bin|sbin|boot|System)\//i, 'Touches system files'],
];

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);

const norm = (p) => path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');
function isInside(file, dir) {
  if (!dir) return false;
  const f = norm(file), d = norm(dir);
  return f === d || f.startsWith(d + path.sep) || f.startsWith(d + '/');
}

// Absolute paths mentioned in a shell command (Windows drive paths, ~, $HOME, %USERPROFILE%, /unix).
function pathsIn(cmd) {
  const out = [];
  const re = /(?:"([a-z]:\\[^"]*)"|'([a-z]:\\[^']*)'|([a-z]:\\[^\s"'|;&<>]*)|(?:^|\s)(~[\\/][^\s"'|;&<>]*)|(\$HOME|\$env:USERPROFILE|%USERPROFILE%)[\\/]?[^\s"'|;&<>]*|(?:^|\s)(\/(?:etc|usr|home|Users|var|opt|root)[^\s"'|;&<>]*))/gi;
  let m;
  while ((m = re.exec(cmd))) {
    const p = m[1] || m[2] || m[3] || m[4] || m[0].trim();
    out.push(p);
  }
  return out;
}

function expandHome(p, home) {
  return p.replace(/^~(?=[\\/])/, home).replace(/^(\$HOME|\$env:USERPROFILE|%USERPROFILE%)/i, home);
}

/**
 * @returns {{ risky: boolean, reasons: string[], summary: string, ruleKey: string }}
 */
function assess(toolName, input, cwd, home) {
  const reasons = [];
  let summary = '';
  let ruleKey = toolName;

  if (COMMAND_TOOLS.has(toolName)) {
    const cmd = String(input?.command || '');
    summary = cmd;
    // Ignore quoted text (commit messages, echo strings) when looking for dangerous verbs.
    const bare = cmd.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
    for (const [re, why] of COMMAND_RULES) if (re.test(bare)) reasons.push(why);
    for (const [re, why] of SENSITIVE) if (re.test(cmd)) reasons.push(why);
    const outside = pathsIn(cmd).map((p) => expandHome(p, home)).filter((p) => !isInside(p, cwd));
    if (outside.length && WRITE_VERBS.test(cmd)) reasons.push(`Changes files and uses a path outside the working folder (${outside[0]})`);
    // "Always allow" remembers the command's first two words, e.g. "git push".
    ruleKey = `${toolName}:${cmd.trim().split(/\s+/).slice(0, 2).join(' ').toLowerCase()}`;
  } else if (EDIT_TOOLS.has(toolName)) {
    const file = String(input?.file_path || input?.notebook_path || '');
    summary = file;
    if (file && !isInside(file, cwd)) reasons.push('Edits a file outside the working folder');
    for (const [re, why] of SENSITIVE) if (re.test(file)) reasons.push(why);
    ruleKey = `${toolName}:${norm(path.dirname(file || '.'))}`;
  } else {
    summary = JSON.stringify(input || {}).slice(0, 300);
    ruleKey = `${toolName}:*`;
  }

  return { risky: reasons.length > 0, reasons: [...new Set(reasons)], summary, ruleKey };
}

module.exports = { assess };
