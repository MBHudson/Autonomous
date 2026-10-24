<?php
namespace Src;

/**
 * Minimal Chrome DevTools Protocol client over a hand-rolled WebSocket.
 *
 * No composer, no package: PHP ships stream sockets, and the WebSocket framing
 * this needs (a text client mask, and reassembling the server's frames) is a
 * few dozen lines. Screenshots arrive as one big base64 payload split across
 * continuation frames, so the reader accumulates until FIN.
 *
 * Only the handful of CDP methods the Browser screen uses are wrapped; anything
 * else can go through send() directly.
 */
class Cdp
{
    /** @var resource */
    private $sock;
    private $id = 0;
    public $lastError = '';

    private function __construct($sock)
    {
        $this->sock = $sock;
    }

    /**
     * Open a WebSocket to a ws:// URL and complete the handshake.
     * @throws \RuntimeException
     */
    public static function connect($wsUrl, $timeoutSec = 15)
    {
        $u = parse_url((string)$wsUrl);
        if (!is_array($u) || empty($u['host']) || empty($u['port'])) {
            throw new \RuntimeException("bad websocket url: $wsUrl");
        }
        $host = $u['host'];
        $port = (int)$u['port'];
        $path = ($u['path'] ?? '/');
        if (!empty($u['query'])) { $path .= '?' . $u['query']; }

        $ctx = stream_context_create();
        $sock = @stream_socket_client(
            "tcp://$host:$port", $errno, $errstr, $timeoutSec,
            STREAM_CLIENT_CONNECT, $ctx
        );
        if (!$sock) {
            throw new \RuntimeException("cannot connect to $host:$port ($errstr)");
        }
        stream_set_timeout($sock, $timeoutSec);

        $key = base64_encode(random_bytes(16));
        $req = "GET $path HTTP/1.1\r\n"
            . "Host: $host:$port\r\n"
            . "Upgrade: websocket\r\n"
            . "Connection: Upgrade\r\n"
            . "Sec-WebSocket-Key: $key\r\n"
            . "Sec-WebSocket-Version: 13\r\n\r\n";
        fwrite($sock, $req);

        // Read the response headers (up to the blank line).
        $header = '';
        $deadline = microtime(true) + $timeoutSec;
        while (strpos($header, "\r\n\r\n") === false) {
            if (microtime(true) > $deadline) { fclose($sock); throw new \RuntimeException('websocket handshake timed out'); }
            $chunk = fread($sock, 1024);
            if ($chunk === '' || $chunk === false) {
                $meta = stream_get_meta_data($sock);
                if (!empty($meta['timed_out'])) { fclose($sock); throw new \RuntimeException('websocket handshake timed out'); }
                break;
            }
            $header .= $chunk;
        }
        if (stripos($header, ' 101 ') === false) {
            fclose($sock);
            throw new \RuntimeException('websocket upgrade refused: ' . trim(strtok($header, "\r\n")));
        }
        return new self($sock);
    }

    public function close()
    {
        if (is_resource($this->sock)) {
            // Best-effort close frame (opcode 8, masked, empty).
            @fwrite($this->sock, $this->frame('', 0x8));
            @fclose($this->sock);
        }
        $this->sock = null;
    }

    /** Build one masked client frame. */
    private function frame($payload, $opcode = 0x1)
    {
        $len = strlen($payload);
        $head = chr(0x80 | $opcode);          // FIN + opcode
        if ($len < 126) {
            $head .= chr(0x80 | $len);
        } elseif ($len <= 0xFFFF) {
            $head .= chr(0x80 | 126) . pack('n', $len);
        } else {
            $head .= chr(0x80 | 127) . pack('J', $len);
        }
        $mask = random_bytes(4);
        $masked = '';
        for ($i = 0; $i < $len; $i++) {
            $masked .= $payload[$i] ^ $mask[$i % 4];
        }
        return $head . $mask . $masked;
    }

    /** Read exactly $n bytes, or throw on timeout/EOF. */
    private function readN($n, $deadline)
    {
        $out = '';
        while (strlen($out) < $n) {
            if (microtime(true) > $deadline) { throw new \RuntimeException('cdp read timed out'); }
            $chunk = fread($this->sock, $n - strlen($out));
            if ($chunk === '' || $chunk === false) {
                $meta = stream_get_meta_data($this->sock);
                if (!empty($meta['timed_out'])) { throw new \RuntimeException('cdp read timed out'); }
                if (feof($this->sock)) { throw new \RuntimeException('cdp connection closed'); }
                usleep(2000);
                continue;
            }
            $out .= $chunk;
        }
        return $out;
    }

    /** Read one complete WebSocket message (text), reassembling continuations. */
    private function readMessage($deadline)
    {
        $message = '';
        while (true) {
            $b = $this->readN(2, $deadline);
            $fin = (ord($b[0]) & 0x80) !== 0;
            $opcode = ord($b[0]) & 0x0F;
            $masked = (ord($b[1]) & 0x80) !== 0;
            $len = ord($b[1]) & 0x7F;
            if ($len === 126) { $len = unpack('n', $this->readN(2, $deadline))[1]; }
            elseif ($len === 127) { $len = unpack('J', $this->readN(8, $deadline))[1]; }
            $mask = $masked ? $this->readN(4, $deadline) : '';
            $payload = $len ? $this->readN($len, $deadline) : '';
            if ($masked) {
                for ($i = 0; $i < $len; $i++) { $payload[$i] = $payload[$i] ^ $mask[$i % 4]; }
            }
            if ($opcode === 0x8) { throw new \RuntimeException('cdp socket closed by peer'); }
            if ($opcode === 0x9) {   // ping → pong (unmasked server-bound)
                @fwrite($this->sock, chr(0x8A) . chr(strlen($payload)) . $payload);
                continue;
            }
            if ($opcode === 0xA) { continue; }   // pong
            $message .= $payload;
            if ($fin) return $message;
        }
    }

    /**
     * Send a CDP command and return its `result` (throws on a CDP error).
     * Events without an id are ignored while we wait for our reply.
     */
    public function send($method, $params = [], $timeoutSec = 20)
    {
        $this->id++;
        $myId = $this->id;
        $msg = json_encode(['id' => $myId, 'method' => $method, 'params' => (object)$params],
            JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        fwrite($this->sock, $this->frame($msg));
        $deadline = microtime(true) + $timeoutSec;
        while (true) {
            $raw = $this->readMessage($deadline);
            $json = json_decode($raw, true);
            if (!is_array($json) || !isset($json['id']) || (int)$json['id'] !== $myId) {
                continue;   // an event, or a reply to an earlier id
            }
            if (isset($json['error'])) {
                throw new \RuntimeException('cdp ' . $method . ': ' . ($json['error']['message'] ?? 'error'));
            }
            return $json['result'] ?? [];
        }
    }

    // ---- the handful the screen uses -------------------------------------

    public function navigate($url, $timeoutSec = 12)
    {
        // No Page.enable: it makes Chrome stream the whole Page.* event firehose
        // that our reader then has to discard, and it is not needed to navigate.
        $this->send('Page.navigate', ['url' => (string)$url], 15);
        // Wait only until the document is no longer 'loading'. 'interactive' is
        // already enough to screenshot, and heavy sites (websockets, long-poll)
        // reach 'complete' far later or never — which is what made a page take
        // minutes: every navigation sat out the full timeout.
        $deadline = microtime(true) + $timeoutSec;
        $wait = 150000;   // 150ms, backing off gently
        while (microtime(true) < $deadline) {
            try {
                $r = $this->send('Runtime.evaluate', [
                    'expression' => 'document.readyState', 'returnByValue' => true,
                ], 5);
                $state = $r['result']['value'] ?? '';
                if ($state === 'interactive' || $state === 'complete') break;
            } catch (\Throwable $e) { /* keep waiting */ }
            usleep($wait);
            $wait = (int) min(600000, $wait * 1.4);
        }
        return $this->info();
    }

    public function info()
    {
        $r = $this->send('Runtime.evaluate', [
            'expression' => 'JSON.stringify({url:location.href,title:document.title})',
            'returnByValue' => true,
        ]);
        $val = $r['result']['value'] ?? '{}';
        $j = json_decode($val, true);
        return ['url' => $j['url'] ?? '', 'title' => $j['title'] ?? ''];
    }

    public function screenshot()
    {
        $r = $this->send('Page.captureScreenshot', ['format' => 'png'], 30);
        return $r['data'] ?? '';
    }

    public function click($x, $y, $button = 'left')
    {
        $base = ['x' => (float)$x, 'y' => (float)$y, 'button' => $button, 'clickCount' => 1];
        $this->send('Input.dispatchMouseEvent', $base + ['type' => 'mouseMoved']);
        $this->send('Input.dispatchMouseEvent', $base + ['type' => 'mousePressed']);
        $this->send('Input.dispatchMouseEvent', $base + ['type' => 'mouseReleased']);
    }

    public function typeText($text)
    {
        $this->send('Input.insertText', ['text' => (string)$text]);
    }

    public function key($key)
    {
        $codes = ['Enter' => 13, 'Tab' => 9, 'Backspace' => 8, 'Escape' => 27];
        $vk = $codes[$key] ?? 0;
        $common = ['key' => $key, 'code' => $key, 'windowsVirtualKeyCode' => $vk, 'nativeVirtualKeyCode' => $vk];
        $this->send('Input.dispatchKeyEvent', $common + ['type' => 'keyDown']);
        $this->send('Input.dispatchKeyEvent', $common + ['type' => 'keyUp']);
    }

    public function evaluate($expr)
    {
        $r = $this->send('Runtime.evaluate', [
            'expression' => (string)$expr, 'returnByValue' => true, 'awaitPromise' => true,
        ]);
        if (isset($r['exceptionDetails'])) {
            throw new \RuntimeException('JS: ' . ($r['exceptionDetails']['text'] ?? 'error'));
        }
        $v = $r['result']['value'] ?? null;
        return is_scalar($v) || $v === null ? $v : json_encode($v, JSON_UNESCAPED_SLASHES);
    }

    public function readText()
    {
        return (string)$this->evaluate('document.body ? document.body.innerText : ""');
    }
}
