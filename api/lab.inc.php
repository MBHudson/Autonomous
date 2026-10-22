<?php
// ============================================
// API LAB — server-side request runner
// ============================================
//
// WHY THIS EXISTS: the browser cannot call most API hosts. NVIDIA, Anthropic
// and a lot of others send no CORS headers, so fetch() from the page fails
// before a single byte of the reply is readable, and the browser's error says
// nothing about why. Sending from here means the Lab can reach the endpoint
// you actually care about and show you what came back.
//
// WHAT THIS IS NOT: a general-purpose proxy. It is gated behind the same
// access token as every other endpoint (the check runs before dispatch), and
// it refuses the cloud metadata address, which is the one thing a
// "send this URL for me" feature on a cloud box must never be able to reach.

/** Cloud instance-metadata endpoints. These hand out credentials to anything
 *  that asks. A request runner that can be pointed anywhere must never be
 *  pointed here. */
function lab_blocked_host(string $host): bool {
    $host = strtolower(trim($host));
    if ($host === '') return true;
    // Link-local and the two well-known metadata names.
    $blocked = ['169.254.169.254', 'metadata.google.internal', 'metadata.goog',
                'metadata.azure.com', '100.100.100.200'];
    if (in_array($host, $blocked, true)) return true;
    // Any 169.254.x.x link-local, which is where metadata lives on most hosts.
    if (preg_match('/^169\.254\./', $host)) return true;
    if ($host === 'fd00:ec2::254') return true;
    return false;
}

/** Split a raw header block into a name => value map, last value winning. */
function lab_header_map(string $raw): array {
    $out = [];
    foreach (preg_split('/\r?\n/', $raw) as $line) {
        $line = trim($line);
        if ($line === '' || stripos($line, 'HTTP/') === 0) continue;   // status lines
        $colon = strpos($line, ':');
        if ($colon === false) continue;
        $name = trim(substr($line, 0, $colon));
        $value = trim(substr($line, $colon + 1));
        if ($name !== '') $out[$name] = $value;
    }
    return $out;
}

/**
 * Run one request on behalf of the Lab and report exactly what happened.
 *
 * Errors are returned, never thrown: "DNS failed" and "the key was rejected"
 * are the whole point of the Lab, and a 500 with an HTML body tells the user
 * nothing about which layer refused.
 */
function handleLabRequest($method, $segments, $body) {
    header('Content-Type: application/json');
    header('Cache-Control: no-store');

    if ($method !== 'POST') {
        echo json_encode(['ok' => false, 'error' => 'POST a request to run it']);
        return;
    }

    $url = trim((string)($body['url'] ?? ''));
    $verb = strtoupper(trim((string)($body['method'] ?? 'GET'))) ?: 'GET';
    $reqHeaders = (is_array($body['headers']) && isset($body['headers']) && is_array($body['headers']))
        ? $body['headers'] : [];
    $reqBody = (string)($body['body'] ?? '');
    $timeout = max(1, min(300, (int)($body['timeoutSec'] ?? 60)));

    if ($url === '') {
        echo json_encode(['ok' => false, 'error' => 'No URL to send to.']);
        return;
    }
    if (!preg_match('#^https?://#i', $url)) {
        echo json_encode(['ok' => false, 'error' => 'Only http:// and https:// URLs can be sent.', 'stage' => 'config']);
        return;
    }
    $host = (string)parse_url($url, PHP_URL_HOST);
    if (lab_blocked_host($host)) {
        // Said plainly, because "nothing happened" would send them looking in
        // the wrong place entirely.
        echo json_encode([
            'error' => 'That address is refused: the cloud metadata endpoint is blocked so this tool cannot be used to read instance credentials.',
            'stage' => 'blocked',
        ]);
        return;
    }

    // ---- build the cURL handle -----------------------------------------
    $ch = curl_init();
    $sentHeaders = [];
    foreach ($reqHeaders as $h) {
        if (!is_array($h)) continue;
        $name = trim((string)($h['name'] ?? ''));
        if ($name === '') continue;
        $value = (string)($h['value'] ?? '');
        $sentHeaders[] = $name . ': ' . $value;
    }
    // Let cURL add Host/Content-Length/Accept-Encoding itself; a hand-rolled
    // Host header is a classic way to make a request fail for no visible reason.
    $sentHeaders = array_values(array_filter($sentHeaders, function ($h) {
        return !preg_match('/^(host|content-length|accept-encoding|connection):/i', $h);
    }));

    curl_setopt_array($ch, [
        CURLOPT_URL => $url,
        CURLOPT_CUSTOMREQUEST => $verb,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HEADER => true,               // we report the headers back
        CURLOPT_FOLLOWLOCATION => true,       // providers redirect to /v1 more often than you think
        CURLOPT_MAXREDIRS => 3,
        CURLOPT_CONNECTTIMEOUT => min(15, $timeout),
        CURLOPT_TIMEOUT => $timeout,
        CURLOPT_SSL_VERIFYPEER => true,       // a Lab that lies about TLS proves nothing
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_HTTPHEADER => $sentHeaders,
        CURLOPT_USERAGENT => 'Autonomous-Loop-Studio-API-Lab',
        CURLOPT_NOBODY => ($verb === 'HEAD'),
    ]);
    if ($reqBody !== '' && $verb !== 'GET' && $verb !== 'HEAD') {
        curl_setopt($ch, CURLOPT_POSTFIELDS, $reqBody);
    } elseif ($verb === 'POST' && $reqBody === '') {
        // An explicit POST with no body still needs the length, or some hosts
        // answer 411 and it looks like a Lab bug.
        curl_setopt($ch, CURLOPT_POSTFIELDS, '');
    }

    $started = microtime(true);
    $raw = curl_exec($ch);
    $elapsed = (int)round((microtime(true) - $started) * 1000);
    $errno = curl_errno($ch);
    $error = curl_error($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $headerSize = (int)curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    $finalUrl = (string)curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
    $contentType = (string)curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
    curl_close($ch);

    if ($errno) {
        // Name the layer, like handleDiag does. "NetworkError" teaches nothing.
        $stage = 'network';
        $hint = 'The request left PHP but never got an answer.';
        if ($errno === CURLE_COULDNT_RESOLVE_HOST) { $stage = 'dns'; $hint = 'This machine cannot resolve that hostname.'; }
        elseif ($errno === CURLE_SSL_CONNECT_ERROR || $errno === CURLE_SSL_CERTPROBLEM) { $stage = 'tls'; $hint = 'The TLS handshake or certificate was refused. Check the clock on this box too.'; }
        elseif ($errno === CURLE_OPERATION_TIMEOUTED) { $stage = 'timeout'; $hint = 'No answer inside the timeout. The endpoint may be slow, or the URL may point somewhere that does not answer.'; }
        elseif ($errno === CURLE_COULDNT_CONNECT) { $stage = 'connect'; $hint = 'Nothing accepted a connection at that address and port.'; }
        echo json_encode([
            'ok' => false, 'stage' => $stage, 'error' => $error ?: 'request failed',
            'hint' => $hint, 'ms' => $elapsed, 'curl_errno' => $errno, 'final_url' => $finalUrl,
        ]);
        return;
    }

    $headerBlock = substr((string)$raw, 0, $headerSize);
    $responseBody = substr((string)$raw, $headerSize);
    // A 20MB "error" page should not be pushed through a phone browser and a
    // JSON encode. Cut it, and say so rather than quietly truncating.
    $LIMIT = 2 * 1024 * 1024;
    $truncated = false;
    if (strlen($responseBody) > $LIMIT) {
        $responseBody = substr($responseBody, 0, $LIMIT);
        $truncated = true;
    }

    // The last header block is the one that matters after a redirect.
    $blocks = preg_split("/\r?\n\r?\n/", trim($headerBlock));
    $lastBlock = $blocks && count($blocks) ? $blocks[count($blocks) - 1] : $headerBlock;

    echo json_encode([
        'ok' => true,
        'status' => $status,
        'ms' => $elapsed,
        'final_url' => $finalUrl,
        'content_type' => $contentType,
        'headers' => lab_header_map($lastBlock),
        'body' => $responseBody,
        'truncated' => $truncated,
        // Deliberately absent: the request headers. They carry the API key and
        // the caller already has them; echoing them buys nothing and leaks.
    ]);
}