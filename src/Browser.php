<?php
namespace Src;

/**
 * Drives an installed Chrome/Edge over the DevTools Protocol, with no packages.
 *
 * The browser is launched once (headless or with a visible window the operator
 * can watch and take over), against a persistent profile under storage/ so a
 * login survives between sessions. Everything after that is Cdp.
 *
 * Off unless the operator turns it on (Config → Labs → Browser); the API route
 * is token-gated like every other, and only http/https pages may be opened.
 */
class Browser
{
    const STATE = 'browser.json';
    const PROFILE = 'browser-profile';

    /** Candidate executables, first match wins. */
    private static function candidates()
    {
        $out = [];
        if (PHP_OS_FAMILY === 'Windows') {
            $pf = getenv('ProgramFiles') ?: 'C:\\Program Files';
            $pfx = getenv('ProgramFiles(x86)') ?: 'C:\\Program Files (x86)';
            $local = getenv('LOCALAPPDATA') ?: '';
            $out = [
                "$pf\\Google\\Chrome\\Application\\chrome.exe",
                "$pfx\\Google\\Chrome\\Application\\chrome.exe",
                "$local\\Google\\Chrome\\Application\\chrome.exe",
                "$pf\\Microsoft\\Edge\\Application\\msedge.exe",
                "$pfx\\Microsoft\\Edge\\Application\\msedge.exe",
            ];
        } elseif (PHP_OS_FAMILY === 'Darwin') {
            $out = [
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
                '/Applications/Chromium.app/Contents/MacOS/Chromium',
            ];
        } else {
            foreach (['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'] as $bin) {
                foreach (explode(':', getenv('PATH') ?: '/usr/bin') as $dir) {
                    $p = rtrim($dir, '/') . '/' . $bin;
                    if (is_file($p) && is_executable($p)) { $out[] = $p; }
                }
            }
        }
        return $out;
    }

    public static function findExe()
    {
        foreach (self::candidates() as $p) {
            if (is_file($p)) { return $p; }
        }
        return '';
    }

    private static function appDir()
    {
        $dir = realpath(__DIR__ . '/..');
        return $dir === false ? '' : rtrim(str_replace('\\', '/', $dir), '/');
    }

    private static function statePath() { return self::appDir() . '/storage/' . self::STATE; }
    public static function profileDir() { return self::appDir() . '/storage/' . self::PROFILE; }

    private static function state()
    {
        $p = self::statePath();
        if (!is_file($p)) { return null; }
        $j = json_decode((string)@file_get_contents($p), true);
        return is_array($j) ? $j : null;
    }

    private static function saveState($s)
    {
        @file_put_contents(self::statePath(), json_encode($s, JSON_UNESCAPED_SLASHES), LOCK_EX);
    }

    /**
     * GET/PUT a Chrome DevTools HTTP endpoint and parse the JSON.
     *
     * Deliberately NOT file_get_contents: Chrome answers in ~1ms but keeps the
     * socket alive, and file_get_contents then blocks until its timeout (it
     * reads to EOF) — so every status/navigate/screenshot paid several seconds.
     * Reading exactly Content-Length bytes over a raw socket returns at once.
     */
    private static function httpJson($url, $method = 'GET', $timeout = 4)
    {
        $u = parse_url($url);
        $host = $u['host'] ?? '127.0.0.1';
        $port = (int)($u['port'] ?? 80);
        $path = ($u['path'] ?? '/') . (isset($u['query']) ? '?' . $u['query'] : '');

        $fp = @fsockopen($host, $port, $errno, $errstr, $timeout);
        if (!$fp) { return null; }
        stream_set_timeout($fp, $timeout);
        @fwrite($fp, "$method $path HTTP/1.1\r\nHost: $host:$port\r\nAccept: application/json\r\nConnection: close\r\n\r\n");

        // Headers, line by line.
        $header = '';
        while (($line = fgets($fp)) !== false) {
            $header .= $line;
            if ($line === "\r\n" || $line === "\n") { break; }
        }
        if (stripos($header, '200') === false && stripos($header, 'HTTP/') !== false
            && !preg_match('#HTTP/\d\.\d 2\d\d#', $header)) {
            fclose($fp);
            return null;
        }
        // Body: exactly Content-Length bytes when Chrome sends it.
        $len = preg_match('/content-length:\s*(\d+)/i', $header, $m) ? (int)$m[1] : null;
        $body = '';
        if ($len !== null) {
            while (strlen($body) < $len) {
                $chunk = fread($fp, $len - strlen($body));
                if ($chunk === '' || $chunk === false) { break; }
                $body .= $chunk;
            }
        } else {
            while (!feof($fp)) {
                $chunk = fread($fp, 8192);
                if ($chunk === '' || $chunk === false) { break; }
                $body .= $chunk;
            }
        }
        fclose($fp);
        $j = json_decode($body, true);
        return is_array($j) ? $j : null;
    }

    /** Is the debug endpoint answering on this port? */
    private static function livePort($port)
    {
        if (!$port) { return false; }
        $v = self::httpJson("http://127.0.0.1:$port/json/version");
        return is_array($v) && !empty($v['webSocketDebuggerUrl']);
    }

    public static function status()
    {
        $state = self::state();
        $port = (int)($state['port'] ?? 0);
        $running = self::livePort($port);
        return [
            'available' => self::findExe() !== '',
            'exe' => self::findExe(),
            'running' => $running,
            'port' => $running ? $port : 0,
            'headless' => (bool)($state['headless'] ?? true),
        ];
    }

    private static function freePort($start = 9222)
    {
        for ($p = $start; $p < $start + 50; $p++) {
            $l = @stream_socket_server("tcp://127.0.0.1:$p", $e, $s);
            if ($l) { fclose($l); if (!self::livePort($p)) { return $p; } }
        }
        return $start;
    }

    /** Launch (if not already up) and return status with the port. */
    public static function launch($headless = true)
    {
        $exe = self::findExe();
        if ($exe === '') {
            throw new \RuntimeException('No Chrome or Edge found on this machine.');
        }
        $state = self::state();
        if ($state && self::livePort((int)$state['port'])) {
            return self::status();
        }

        $profile = self::profileDir();
        if (!is_dir($profile)) { @mkdir($profile, 0775, true); }
        $port = self::freePort();
        $args = [
            '--remote-debugging-port=' . $port,
            '--user-data-dir=' . $profile,
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-popup-blocking',
            '--remote-allow-origins=*',
            '--window-size=1280,900',
            // Trim the background work that makes a cold headless Chrome slow
            // and chatty (it was spending time on component updates, sync,
            // translate and the like before the page even loaded).
            '--disable-extensions',
            '--disable-component-update',
            '--disable-background-networking',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-default-apps',
            '--disable-sync',
            '--no-service-autorun',
            '--metrics-recording-only',
            '--mute-audio',
            '--disable-features=Translate,MediaRouter,OptimizationHints,CalculateNativeWinOcclusion',
        ];
        if ($headless) { $args[] = '--headless=new'; }
        $args[] = 'about:blank';
        $argLine = implode(' ', array_map(fn($a) => '"' . $a . '"', $args));

        if (PHP_OS_FAMILY === 'Windows') {
            // `start` detaches so the request returns at once.
            @pclose(@popen('cmd /c start "" "' . $exe . '" ' . $argLine, 'r'));
        } else {
            @exec('"' . $exe . '" ' . $argLine . ' > /dev/null 2>&1 &');
        }

        // Wait for the debug port to answer.
        $deadline = microtime(true) + 20;
        while (microtime(true) < $deadline && !self::livePort($port)) {
            usleep(300000);
        }
        if (!self::livePort($port)) {
            throw new \RuntimeException('The browser did not open its debug port. '
                . 'It may have exited; try again, or launch it by hand.');
        }
        self::saveState(['port' => $port, 'headless' => (bool)$headless]);
        return self::status();
    }

    /** Ask the browser to close (works regardless of how it was started). */
    public static function stop()
    {
        $state = self::state();
        $port = (int)($state['port'] ?? 0);
        if ($port) {
            $v = self::httpJson("http://127.0.0.1:$port/json/version");
            $ws = $v['webSocketDebuggerUrl'] ?? '';
            if ($ws) {
                try { $cdp = Cdp::connect($ws, 5); $cdp->send('Browser.close', [], 5); $cdp->close(); }
                catch (\Throwable $e) { /* it may already be gone */ }
            }
        }
        @file_put_contents(self::statePath(), '{}', LOCK_EX);
        return ['running' => false];
    }

    /** The page target's websocket URL, creating a tab if there is none. */
    private static function pageWs($port)
    {
        $list = self::httpJson("http://127.0.0.1:$port/json/list") ?: [];
        foreach ($list as $t) {
            if (($t['type'] ?? '') === 'page' && !empty($t['webSocketDebuggerUrl'])) {
                return $t['webSocketDebuggerUrl'];
            }
        }
        $new = self::httpJson("http://127.0.0.1:$port/json/new?about:blank", 'PUT');
        return $new['webSocketDebuggerUrl'] ?? '';
    }

    /** Refuse non-web schemes and the cloud metadata addresses. */
    public static function checkUrl($url)
    {
        $u = trim((string)$url);
        if ($u === '' || $u === 'about:blank') { return 'about:blank'; }
        if (!preg_match('#^https?://#i', $u)) {
            // Allow a bare host: prepend https.
            if (preg_match('#^[a-z0-9.-]+\.[a-z]{2,}(/|$)#i', $u)) { $u = 'https://' . $u; }
            else { throw new \RuntimeException('Only http and https pages can be opened.'); }
        }
        $host = strtolower((string)parse_url($u, PHP_URL_HOST));
        foreach (['169.254.169.254', 'metadata.google.internal', '100.100.100.200'] as $bad) {
            if ($host === $bad) { throw new \RuntimeException('That address is refused.'); }
        }
        return $u;
    }

    /** Run $fn(Cdp) against the page target, closing the socket after. */
    public static function withCdp(callable $fn)
    {
        $status = self::status();
        if (!$status['running']) { throw new \RuntimeException('The browser is not running. Launch it first.'); }
        $ws = self::pageWs($status['port']);
        if ($ws === '') { throw new \RuntimeException('No page target to control.'); }
        $cdp = Cdp::connect($ws);
        try { return $fn($cdp); } finally { $cdp->close(); }
    }

    // ---- the actions the screen and the tools use ------------------------

    public static function navigate($url)
    {
        $u = self::checkUrl($url);
        return self::withCdp(fn($c) => $c->navigate($u));
    }
    public static function screenshot()
    {
        return ['png' => self::withCdp(fn($c) => $c->screenshot())];
    }
    public static function click($x, $y)
    {
        self::withCdp(fn($c) => $c->click($x, $y));
        return ['ok' => true];
    }
    public static function typeText($text)
    {
        self::withCdp(fn($c) => $c->typeText($text));
        return ['ok' => true];
    }
    public static function pressKey($key)
    {
        self::withCdp(fn($c) => $c->key($key));
        return ['ok' => true];
    }
    public static function evaluate($expr)
    {
        return ['result' => self::withCdp(fn($c) => $c->evaluate($expr))];
    }
    public static function readText()
    {
        return ['text' => self::withCdp(fn($c) => $c->readText())];
    }
}
