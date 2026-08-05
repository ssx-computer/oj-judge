#!/usr/bin/env python3
"""
Static security check for OJ submissions.

Scans untrusted source code for suspicious system calls BEFORE compilation and
execution. Detects network access (socket/http/requests/urllib), process
control (os.system / subprocess / fork / kill / exec), filesystem access
beyond stdin/stdout (absolute paths, judge_data, /etc /proc /home), dynamic
code execution (eval/exec/__import__/ctypes/pickle) and obfuscation primitives.

Usage:
  check_security.py <source_file> <language>

Exit code 0: pass (safe to compile/run).
Exit code 1: blocked — a full result.json payload is printed on stdout:
  {"submission_id": "...", "status": "security_blocked", "details": [...]}
"""
import json
import re
import sys


def load_rules():
    """(language, label, compiled regex) — matched against the raw source."""
    rules = []

    def add(lang, label, pattern):
        rules.append((lang, label, re.compile(pattern)))

    # ---------------- Python ----------------
    add('python', 'os.system / os.popen / exec family / fork / kill',
        r'\bos\.(system|popen|execl|execlp|execle|execv|execvp|execvpe|fork|kill|killpg|spawnl|spawnv)\s*\(')
    add('python', 'subprocess module',
        r'\bsubprocess\s*\.|from\s+subprocess\s+import|\bPopen\s*\(')
    add('python', 'dynamic code execution',
        r'\b(__import__|importlib)\s*\(|\beval\s*\(|\bexec\s*\(|\bcompile\s*\(')
    add('python', 'network sockets',
        r'\bsocket\s*\.|import\s+socket|from\s+socket\s+import|\bAF_INET\b|\bSOCK_STREAM\b|\bgethostbyname\s*\(')
    add('python', 'HTTP / URL libraries',
        r'\b(requests|urllib|urllib2|urllib3|httpx|aiohttp|http)\s*\.|import\s+(requests|urllib|urllib2|urllib3|httpx|aiohttp|http)\b|from\s+(requests|urllib|urllib2|urllib3|http|httpx|aiohttp)\s+import')
    add('python', 'ftp / telnet / smtp',
        r'\b(ftplib|telnetlib|smtplib)\b|import\s+(ftplib|telnetlib|smtplib)')
    add('python', 'ctypes / pickle / pty / marshal',
        r'\bctypes\b|\bpickle\b|\bpty\b|\bmarshal\b|import\s+(ctypes|pickle|pty|marshal)')
    add('python', 'environment / process info access',
        r'\bos\.environ|\benviron\s*\[|\bgetenv\s*\(')
    add('python', 'sensitive path file access',
        r'\bopen\s*\(\s*["\']/|\bopen\s*\(\s*["\'][^"\']*(judge_data|\.\./|/etc/|/proc/|/home/|/root/|/usr/|/var/)')
    add('python', 'builtins tampering / reflection',
        r'__builtins__|\bglobals\s*\(|\blocals\s*\(|\bgetattr\s*\(\s*__builtins__')
    add('python', 'base64 / binascii obfuscation',
        r'\bbase64\s*\.|\bbinascii\s*\.')

    # ---------------- C / C++ ----------------
    add('cpp', 'system / popen / exec family / fork / kill',
        r'\b(system|popen|fork|vfork|execl|execlp|execle|execv|execvp|execve|execvpe|kill|raise|setpgid)\s*\(')
    add('cpp', 'network syscalls',
        r'\b(socket|connect|bind|listen|accept|getaddrinfo|gethostbyname|gethostbyaddr|sendto|recvfrom)\s*\(')
    add('cpp', 'socket / net headers',
        r'#\s*include\s*[<"](sys/socket|netinet|arpa|netdb|sys/un|bluetooth)')
    add('cpp', 'process / ptrace / dl headers',
        r'#\s*include\s*[<"](sys/wait|sys/ptrace|dlfcn|sys/mman|sys/shm|sys/ipc|sys/msg|sys/sem)')
    add('cpp', 'dynamic loading / privileges',
        r'\bdlopen\b|\bsetuid\b|\bsetgid\b|\bchroot\b|\bsetrlimit\b')
    add('cpp', 'sensitive path file access',
        r'\b(open|fopen|freopen|ifstream|ofstream)\s*\(?\s*["\']/?|\bopen\s*\(\s*["\'][^"\']*(judge_data|\.\./|/etc/|/proc/|/home/|/root/)')
    add('cpp', 'file deletion / permission changes',
        r'\b(remove|unlink|rmdir|chmod|chown|rename)\s*\(')
    add('cpp', 'environment access',
        r'\bgetenv\s*\(|environ\b')
    add('cpp', 'inline asm / constructor trickery',
        r'\b__asm__?\b|\b__attribute__\s*\(\s*\(\s*constructor')

    # ---------------- Java ----------------
    add('java', 'process execution',
        r'Runtime\s*\.\s*getRuntime|Runtime\s*\.\s*exec|ProcessBuilder|Process\b')
    add('java', 'network APIs',
        r'java\.net\.|new\s+Socket\s*\(|ServerSocket|SocketChannel|DatagramSocket|HttpURLConnection|URLConnection|java\.http\.|new\s+URL\s*\(|InetAddress')
    add('java', 'native loading / reflection',
        r'System\s*\.\s*load|loadLibrary|Class\s*\.\s*forName|setAccessible|sun\.misc|Unsafe\b')
    add('java', 'sensitive path file access',
        r'new\s+File\s*\(\s*["\']/|FileInputStream\s*\(\s*["\']/|FileOutputStream\s*\(\s*["\']/|Files\.(readAllBytes|newInputStream|newOutputStream)\s*\(\s*[^,)]*["\']/')
    add('java', 'environment access',
        r'System\s*\.\s*getenv|System\s*\.\s*getProperties')

    # ---------------- JavaScript / Node.js ----------------
    add('javascript', 'dangerous module requires',
        r'require\s*\(\s*["\'](child_process|net|http|https|fs|dns|tls|dgram|cluster|worker_threads|os|vm|module|zlib)["\']|from\s*["\'](child_process|net|http|https|fs|dns|tls|dgram|worker_threads|os|vm)["\']')
    add('javascript', 'process control / env access',
        r'process\.env|process\.kill|process\.binding|process\.chdir|process\.umask')
    add('javascript', 'network APIs',
        r'\bfetch\s*\(|XMLHttpRequest|WebSocket\b|EventSource\b|\bhttp[s]?\.(request|get)\s*\(')
    add('javascript', 'dynamic code execution',
        r'\beval\s*\(|\bFunction\s*\(|new\s+Function\s*\(')
    add('javascript', 'filesystem / child process',
        r'fs\.(readFile|writeFile|readdir|open|unlink|rm|rmdir|rename|createReadStream)|child_process|execSync|spawnSync')

    # ---------------- Go ----------------
    add('go', 'network imports / calls',
        r'import\s+"net"|import\s+\w+\s+"net"|import\s+"net/http"|\bnet\.(Dial|Listen|DialTCP|DialUDP)\s*\(|\bhttp\.')
    add('go', 'process execution',
        r'import\s+"os/exec"|\bexec\.Command\b|\bsyscall\.')
    add('go', 'unsafe / low-level',
        r'import\s+"unsafe"|\bunsafe\.')
    add('go', 'file system access',
        r'os\.(ReadFile|Open|Remove|RemoveAll|Rename|MkdirAll|Chmod|Chown|Kill|FindProcess|Getenv|Environ)\s*\(')
    add('go', 'network low-level',
        r'import\s+"syscall"|SYS_|syscall\.Socket|syscall\.Connect')

    # ---------------- Rust ----------------
    add('rust', 'process / net / fs / env std modules',
        r'std::(process|net|fs|env|os)|\bCommand::new\b|\bTcpStream\b|\bUdpSocket\b|\bFile::open\b|\bunsafe\b|\blibc::')
    add('rust', 'socket includes / low-level',
        r'std::os::unix|std::os::fd|/proc/|/etc/')

    return rules


RULES = load_rules()

# Labels that are worth reporting in the message with their matched line.
def find_matches(source, language):
    lines = source.splitlines()
    hits = []
    for lang, label, pattern in RULES:
        if lang != language:
            continue
        m = pattern.search(source)
        if m:
            # locate line number
            lineno = 1 + source.count('\n', 0, m.start())
            hits.append((label, lineno))
    return hits


def main():
    if len(sys.argv) < 3:
        print('usage: check_security.py <source_file> <language>', file=sys.stderr)
        return 2
    source_file = sys.argv[1]
    language = sys.argv[2]
    submission_id = sys.argv[3] if len(sys.argv) > 3 else ''

    try:
        with open(source_file, 'r', encoding='utf-8', errors='replace') as f:
            source = f.read()
    except OSError as e:
        # File unreadable: treat as pass so the judge reports its own error.
        print(f'warning: cannot read {source_file}: {e}', file=sys.stderr)
        return 0

    hits = find_matches(source, language)
    if not hits:
        return 0

    seen = set()
    lines = []
    for label, lineno in hits:
        key = (label, lineno)
        if key in seen:
            continue
        seen.add(key)
        lines.append({'status': 'security_blocked',
                      'message': f'Suspicious call detected at line {lineno}: {label}',
                      'line': lineno, 'category': label})

    payload = {
        'submission_id': submission_id,
        'status': 'security_blocked',
        'details': lines,
    }
    print(json.dumps(payload, ensure_ascii=False))
    return 1


if __name__ == '__main__':
    sys.exit(main())
