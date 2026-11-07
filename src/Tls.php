<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

namespace Src;

/**
 * Certificate policy for every outbound model and speech call.
 *
 * WHAT THIS REPLACES
 *
 * Every curl handle here used to carry a hardcoded
 * `CURLOPT_SSL_VERIFYPEER => false`, and the proxy branches also set
 * `CURLOPT_SSL_VERIFYHOST => 0`. That was a one-line fix for a self-signed
 * certificate on somebody's dev box, and it stayed: on every call to every
 * provider the app accepted whatever certificate answered, never checked the
 * hostname, and still sent the API key and the prompt. Anyone in the path --
 * café wifi, a shared VPS neighbour, a proxy picked from a free list -- could
 * answer in the provider's place, read the repo code going up, and write the
 * "model's reply" coming down.
 *
 * WHAT IT DOES NOW
 *
 * The decision is one setting, `tls.verify` in storage/config.json, editable in
 * Config -> TLS / Certificates:
 *
 *   auto (default)  Verify public hosts. Skip verification for loopback, LAN
 *                   addresses and single-label host names, which is where a
 *                   self-signed certificate actually lives: LM Studio, Ollama,
 *                   llama.cpp, a NAS, a box called "workstation". Those calls
 *                   keep working with no configuration at all.
 *   on              Verify everything, including LAN. The right choice when
 *                   the LAN host has a real certificate or a CA bundle is set.
 *   off             Verify nothing, hostname included. For a self-signed
 *                   endpoint on a network you trust; says so where it is set.
 *
 * Plain `http://` endpoints are untouched by any of this: there is no
 * certificate in the exchange, so a local runner over http works exactly as it
 * did. Nothing here rewrites, upgrades or rejects a URL scheme.
 *
 * `tls.ca_bundle` names a PEM file to trust in addition to the system store --
 * the usual way to make a self-signed LAN host verify properly instead of
 * turning verification off.
 */
class Tls {

    const AUTO = 'auto';
    const ON = 'on';
    const OFF = 'off';

    /** Warn this many days before a pinned certificate expires. */
    const EXPIRY_WARN_DAYS = 30;

    /** Anything unrecognised is AUTO: a typo must not silently disarm checks. */
    public static function normalise($value) {
        $v = strtolower(trim((string)$value));
        return in_array($v, [self::ON, self::OFF], true) ? $v : self::AUTO;
    }

    /** The configured mode. Never throws: routing config must not break a call. */
    public static function mode() {
        try {
            $cfg = Config::loadConfig();
            return self::normalise($cfg['tls']['verify'] ?? self::AUTO);
        } catch (\Throwable $e) {
            return self::AUTO;
        }
    }

    /** An operator-supplied CA bundle, when it is actually readable. */
    public static function caBundle() {
        try {
            $cfg = Config::loadConfig();
            $path = trim((string)($cfg['tls']['ca_bundle'] ?? ''));
        } catch (\Throwable $e) {
            return '';
        }
        if ($path !== '' && is_file($path) && is_readable($path)) { return $path; }
        // No operator bundle: fall back to the certificates pinned through the
        // UI (Config -> TLS / Certificates -> Pin). An explicit ca_bundle wins,
        // so nothing an operator typed is ever silently overridden.
        $pins = self::pinsPath();
        return (is_file($pins) && is_readable($pins)) ? $pins : '';
    }

    /** Host part of a URL, lowercased, without brackets or a trailing dot. */
    public static function host($url) {
        $url = trim((string)$url);
        if ($url === '') { return ''; }
        $parts = @parse_url($url);
        if (!is_array($parts) || !isset($parts['host'])) {
            // Some endpoints arrive without a scheme; parse_url then puts the
            // whole thing in "path". Retry with a scheme so "localhost:1234/x"
            // still yields a host.
            $parts = @parse_url('http://' . ltrim($url, '/'));
        }
        $host = is_array($parts) ? (string)($parts['host'] ?? '') : '';
        $host = strtolower(trim($host, " \t\n\r\0\x0B[]"));
        return rtrim($host, '.');
    }

    /**
     * Is this URL on a network where a self-signed certificate is the norm?
     *
     * Loopback and private/link-local addresses, mDNS names, and single-label
     * host names ("workstation", "gpubox") all count. Anything else -- a real
     * domain, a public IP, an Azure/OpenRouter/Anthropic host -- does not.
     */
    public static function isLocalUrl($url) {
        $host = self::host($url);
        if ($host === '') { return false; }
        if ($host === 'localhost' || $host === '::1' || $host === '0.0.0.0') { return true; }
        if (substr($host, -10) === '.localhost') { return true; }
        foreach (['.local', '.lan', '.internal', '.home.arpa', '.home', '.localdomain'] as $suffix) {
            if (substr($host, -strlen($suffix)) === $suffix) { return true; }
        }
        if ($host === 'host.docker.internal' || $host === 'gateway.docker.internal') { return true; }

        // IPv4 literal, testable in ranges.
        if (filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
            $long = ip2long($host);
            if ($long === false) { return false; }
            $ranges = [
                ['127.0.0.0', 8],    // loopback
                ['10.0.0.0', 8],     // private
                ['172.16.0.0', 12],  // private
                ['192.168.0.0', 16], // private
                ['169.254.0.0', 16], // link-local
                ['100.64.0.0', 10],  // carrier-grade NAT, also common on LANs
                ['0.0.0.0', 8],      // "this host"
            ];
            foreach ($ranges as $r) {
                $mask = -1 << (32 - $r[1]);
                if (($long & $mask) === (ip2long($r[0]) & $mask)) { return true; }
            }
            return false;
        }

        // IPv6 literal outside ::1 is left verified: guessing at ULA prefixes
        // would quietly stop checking a real public endpoint.
        if (strpos($host, ':') !== false) { return false; }

        // A name with no dot cannot be a public DNS name; it is this machine or
        // a name this LAN resolves.
        return strpos($host, '.') === false;
    }

    /**
     * The decision for one URL: is it TLS at all, is the peer verified, and
     * which CA file is trusted.
     *
     * Pure -- no curl constants, no handle -- so the policy can be asserted on
     * an install whose CLI has no curl extension. `tls` is false for a plain
     * http URL, where no certificate exists and nothing can be checked.
     *
     * @return array{tls:bool, verify:bool, ca:string}
     */
    public static function policy($url, $mode = null) {
        $url = trim((string)$url);
        if ($url === '' || !preg_match('~^https://~i', $url)) {
            return ['tls' => false, 'verify' => false, 'ca' => ''];
        }
        $mode = $mode === null ? self::mode() : self::normalise($mode);
        if ($mode === self::OFF) { return ['tls' => true, 'verify' => false, 'ca' => '']; }
        $verify = ($mode === self::ON) ? true : !self::isLocalUrl($url);
        return [
            'tls' => true,
            'verify' => $verify,
            'ca' => $verify ? self::caBundle() : '',
        ];
    }

    /** Would a call to this URL check the certificate? */
    public static function shouldVerify($url, $mode = null) {
        return self::policy($url, $mode)['verify'];
    }

    /**
     * The curl options this URL needs, as an array.
     *
     * Empty means "nothing to set": a plain http URL, or a CLI built without
     * the curl extension (where there is no handle to configure either).
     */
    public static function optionsFor($url, $mode = null) {
        $p = self::policy($url, $mode);
        if (!$p['tls'] || !function_exists('curl_setopt_array')) { return []; }
        $opts = [
            CURLOPT_SSL_VERIFYPEER => $p['verify'],
            CURLOPT_SSL_VERIFYHOST => $p['verify'] ? 2 : 0,
        ];
        if ($p['ca'] !== '') { $opts[CURLOPT_CAINFO] = $p['ca']; }
        return $opts;
    }

    /** Apply the policy to a handle. Returns the options that were set. */
    public static function apply($ch, $url) {
        $opts = self::optionsFor($url);
        if ($ch && $opts) { curl_setopt_array($ch, $opts); }
        return $opts;
    }

    /**
     * Where pinned certificates are written.
     *
     * One file, inside storage/, so nothing here can append to a system trust
     * store. ROUTER_TLS_PINS overrides it for tests, the way ROUTER_CONFIG does
     * for the config file.
     */
    public static function pinsPath() {
        $env = getenv('ROUTER_TLS_PINS');
        if (is_string($env) && trim($env) !== '') { return trim($env); }
        return dirname(__DIR__) . DIRECTORY_SEPARATOR . 'storage' . DIRECTORY_SEPARATOR
            . 'tls' . DIRECTORY_SEPARATOR . 'trusted.pem';
    }

    /** The ca_bundle the operator typed, if it is readable. Never the pin file. */
    public static function configuredBundle() {
        try {
            $cfg = Config::loadConfig();
            $path = trim((string)($cfg['tls']['ca_bundle'] ?? ''));
        } catch (\Throwable $e) {
            return '';
        }
        return ($path !== '' && is_file($path) && is_readable($path)) ? $path : '';
    }

    /**
     * The origin an https endpoint lives on: scheme, host and non-default port.
     *
     * Empty for anything that is not https -- a plain http endpoint presents no
     * certificate, so there is nothing to read or pin.
     */
    public static function origin($url) {
        $url = trim((string)$url);
        if (!preg_match('~^https://~i', $url)) { return ''; }
        $parts = @parse_url($url);
        if (!is_array($parts) || empty($parts['host'])) { return ''; }
        $host = trim(strtolower((string)$parts['host']), '[]');
        if ($host === '') { return ''; }
        $authority = strpos($host, ':') !== false ? '[' . $host . ']' : $host;
        $port = (int)($parts['port'] ?? 0);
        if ($port > 0 && $port !== 443) { $authority .= ':' . $port; }
        return 'https://' . $authority . '/';
    }

    /** SHA-256 of a PEM certificate, colon-separated the way openssl prints it. */
    public static function fingerprintFromPem($pem) {
        if (!preg_match('~-----BEGIN CERTIFICATE-----(.+?)-----END CERTIFICATE-----~s', (string)$pem, $m)) {
            return '';
        }
        $der = base64_decode(preg_replace('~\s+~', '', $m[1]), true);
        if ($der === false || $der === '') { return ''; }
        return strtoupper(implode(':', str_split(hash('sha256', $der), 2)));
    }

    /** Every fingerprint already present in a bundle file. */
    public static function pinnedFingerprints($file = null) {
        $file = $file ?: self::pinsPath();
        $body = (is_file($file) && is_readable($file)) ? (string)@file_get_contents($file) : '';
        $out = [];
        if ($body !== '' && preg_match_all('~-----BEGIN CERTIFICATE-----.+?-----END CERTIFICATE-----~s', $body, $m)) {
            foreach ($m[0] as $pem) {
                $fp = self::fingerprintFromPem($pem);
                if ($fp !== '') { $out[$fp] = rtrim($pem) . "\n"; }
            }
        }
        return $out;
    }

    /**
     * Append certificate PEMs to a bundle, skipping any already there.
     *
     * Matching is by fingerprint, so pinning the same host twice is a no-op and
     * a rotated certificate simply adds a second entry (the operator can prune
     * the file). Anything that is not a PEM certificate is dropped rather than
     * written: a junk file in the bundle path makes every call fail to verify.
     *
     * @return array{path:string,added:int,total:int,error:string}
     */
    public static function appendPins(array $pems, $target = null) {
        $target = $target ?: self::pinsPath();
        $known = self::pinnedFingerprints($target);
        $existing = (is_file($target) && is_readable($target)) ? (string)@file_get_contents($target) : '';
        $added = 0;
        $keep = [];
        foreach ($pems as $pem) {
            if (!preg_match('~-----BEGIN CERTIFICATE-----(.+?)-----END CERTIFICATE-----~s', (string)$pem, $m)) {
                continue;
            }
            $block = rtrim($m[0]);
            $fp = self::fingerprintFromPem($block);
            if ($fp === '' || isset($known[$fp])) { continue; }
            $known[$fp] = $block . "\n";
            $keep[] = $block . "\n";
            $added++;
        }
        if ($added === 0) {
            return ['path' => $target, 'added' => 0, 'total' => count($known), 'error' => ''];
        }
        $dir = dirname($target);
        if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
            return ['path' => $target, 'added' => 0, 'total' => count($known),
                'error' => 'could not create ' . $dir];
        }
        $body = ($existing !== '' ? rtrim($existing) . "\n" : '') . implode('', $keep);
        if (@file_put_contents($target, $body, LOCK_EX) === false) {
            return ['path' => $target, 'added' => 0, 'total' => count($known),
                'error' => 'could not write ' . $target];
        }
        return ['path' => $target, 'added' => $added, 'total' => count($known), 'error' => ''];
    }

    /**
     * Read the certificate chain a host presents, without trusting it.
     *
     * curl's CERTINFO hands back the chain it saw, including the PEM in each
     * entry, so this needs neither the openssl extension nor an external tool.
     * Verification is off for THIS request only: it is how the certificate is
     * read before anybody has decided to trust it. The operator sees the
     * fingerprint, and from then on the ordinary policy verifies against it.
     *
     * @return array{ok:bool,error:string,origin:string,chain:array,meta:array}
     */
    private static function readChain($url) {
        $origin = self::origin($url);
        $out = ['ok' => false, 'error' => '', 'origin' => $origin, 'chain' => [], 'meta' => [], 'metas' => []];
        if ($origin === '') {
            $out['error'] = 'Only https:// endpoints present a certificate. A plain http:// endpoint has none to read.';
            return $out;
        }
        if (!function_exists('curl_init')) {
            $out['error'] = "PHP's curl extension is not enabled, so this server cannot read a host's certificate.";
            return $out;
        }
        $ch = curl_init($origin);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_NOBODY => true,          // handshake only; no body wanted
            CURLOPT_TIMEOUT => 12,
            CURLOPT_CONNECTTIMEOUT => 8,
            CURLOPT_FOLLOWLOCATION => false, // never read a cert from a redirect target
            CURLOPT_CERTINFO => true,
            CURLOPT_SSL_VERIFYPEER => false, // read first, trust after the operator confirms
            CURLOPT_SSL_VERIFYHOST => 0,
        ]);
        curl_exec($ch);
        $err = curl_error($ch);
        $info = curl_getinfo($ch, CURLINFO_CERTINFO);
        curl_close($ch);

        $chain = [];
        $meta = [];
        $metas = [];
        foreach ((array)$info as $i => $entry) {
            if (!is_array($entry)) { continue; }
            $pem = (string)($entry['Cert'] ?? '');
            if ($pem === '') { continue; }
            $chain[] = $pem;
            $metas[] = $entry;
            if ($i === 0) { $meta = $entry; }
        }
        if (!$chain) {
            $out['error'] = $err !== ''
                ? 'Could not reach ' . $origin . ': ' . $err
                : 'The host answered without presenting a certificate.';
            return $out;
        }
        $out['ok'] = true;
        $out['chain'] = $chain;
        $out['meta'] = $meta;
        $out['metas'] = $metas;
        return $out;
    }

    /** What a host presents, formatted for the operator. Nothing is written. */
    public static function inspect($url) {
        $seen = self::readChain($url);
        if (!$seen['ok']) { return ['ok' => false, 'error' => $seen['error']]; }
        $meta = $seen['meta'];
        $fp = self::fingerprintFromPem($seen['chain'][0]);
        $pinned = self::pinnedFingerprints();
        return [
            'ok' => true,
            'origin' => $seen['origin'],
            'host' => self::host($seen['origin']),
            'fingerprint' => $fp,
            'subject' => (string)($meta['Subject'] ?? ''),
            'issuer' => (string)($meta['Issuer'] ?? ''),
            'from' => (string)($meta['Start date'] ?? ''),
            'to' => (string)($meta['Expire date'] ?? ''),
            'chain' => count($seen['chain']),
            'already_pinned' => isset($pinned[$fp]),
            'bundle' => self::pinsPath(),
        ];
    }

    /**
     * Read the host's chain and add it to the pin bundle, so verification can
     * succeed against a self-signed or privately issued certificate.
     *
     * The whole presented chain is written, not just the leaf: a self-signed
     * leaf then works as its own trust anchor, and a private CA plus its
     * intermediate verifies without the operator assembling anything.
     */
    public static function pin($url) {
        $seen = self::readChain($url);
        if (!$seen['ok']) { return ['ok' => false, 'error' => $seen['error']]; }
        $res = self::appendPins($seen['chain']);
        if ($res['error'] !== '') {
            return ['ok' => false, 'error' => $res['error']];
        }
        $meta = $seen['meta'];
        $fp = self::fingerprintFromPem($seen['chain'][0]);
        // Remember what each certificate is, so the pin list can show a name and
        // an expiry instead of a bare fingerprint.
        self::recordChainMeta($seen);
        $custom = self::configuredBundle();
        return [
            'ok' => true,
            'origin' => $seen['origin'],
            'host' => self::host($seen['origin']),
            'fingerprint' => $fp,
            'subject' => (string)($meta['Subject'] ?? ''),
            'issuer' => (string)($meta['Issuer'] ?? ''),
            'from' => (string)($meta['Start date'] ?? ''),
            'to' => (string)($meta['Expire date'] ?? ''),
            'chain' => count($seen['chain']),
            'added' => $res['added'],
            'total' => $res['total'],
            'written' => $res['added'] > 0,
            'bundle' => $res['path'],
            'note' => ($custom !== '' && $custom !== $res['path'])
                ? 'A custom ca_bundle is set, so pinned certificates are stored but not used until that field is cleared.'
                : '',
        ];
    }

    /**
     * Sidecar holding the display metadata for each pin.
     *
     * The bundle itself is only certificates -- it has to stay a PEM file curl
     * will read -- so the names, dates and pin time live beside it, keyed by
     * fingerprint. A bundle copied in by hand simply has no rows, and the list
     * falls back to what the certificate itself says.
     */
    public static function metaPath() {
        $env = getenv('ROUTER_TLS_PINS_META');
        if (is_string($env) && trim($env) !== '') { return trim($env); }
        return dirname(self::pinsPath()) . DIRECTORY_SEPARATOR . 'pins.json';
    }

    /** Every metadata row, keyed by fingerprint. Never throws. */
    public static function pinMeta() {
        $path = self::metaPath();
        if (!is_file($path) || !is_readable($path)) { return []; }
        $raw = json_decode((string)@file_get_contents($path), true);
        return is_array($raw) ? $raw : [];
    }

    /** Merge rows into the metadata map (fingerprint => row). */
    public static function setPinMeta(array $map) {
        if (!$map) { return false; }
        $all = self::pinMeta();
        $changed = false;
        foreach ($map as $fp => $row) {
            if (!is_string($fp) || $fp === '' || !is_array($row)) { continue; }
            $all[$fp] = array_merge($all[$fp] ?? [], $row);
            $changed = true;
        }
        if (!$changed) { return false; }
        $dir = dirname(self::metaPath());
        if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) { return false; }
        return @file_put_contents(self::metaPath(), json_encode($all, JSON_PRETTY_PRINT), LOCK_EX) !== false;
    }

    /** `Nov  7 10:00:00 2027 GMT` -> `2027-11-07`; unchanged when unparsable. */
    private static function dateLabel($raw) {
        $raw = trim((string)$raw);
        if ($raw === '') { return ''; }
        $ts = strtotime($raw);
        return $ts ? gmdate('Y-m-d', $ts) : $raw;
    }

    /** A distinguished name from openssl_x509_parse (array) as one line. */
    private static function dnLabel($dn) {
        if (is_string($dn)) { return $dn; }
        if (!is_array($dn)) { return ''; }
        $parts = [];
        foreach ($dn as $k => $v) {
            $parts[] = $k . '=' . (is_array($v) ? implode('+', array_map('strval', $v)) : (string)$v);
        }
        return implode(', ', $parts);
    }

    /** Record the display metadata for every certificate in a read chain. */
    private static function recordChainMeta(array $seen) {
        $host = self::host((string)($seen['origin'] ?? ''));
        $map = [];
        foreach ((array)($seen['chain'] ?? []) as $i => $pem) {
            $fp = self::fingerprintFromPem($pem);
            if ($fp === '') { continue; }
            $m = (array)($seen['metas'][$i] ?? []);
            $expires = strtotime((string)($m['Expire date'] ?? ''));
            $map[$fp] = [
                'host' => $host,
                'subject' => (string)($m['Subject'] ?? ''),
                'issuer' => (string)($m['Issuer'] ?? ''),
                'from' => self::dateLabel($m['Start date'] ?? ''),
                'to' => self::dateLabel($m['Expire date'] ?? ''),
                'expires_ts' => $expires ? (int)$expires : 0,
                'pinned_at' => time(),
            ];
        }
        if ($map) { self::setPinMeta($map); }
    }

    /**
     * Everything in the pin bundle, soonest expiry first.
     *
     * `expired` is true/false where the expiry is known and null where it is
     * not, so the UI can say "validity unknown" instead of guessing.
     */
    public static function pins() {
        $meta = self::pinMeta();
        $out = [];
        foreach (self::pinnedFingerprints() as $fp => $pem) {
            $row = is_array($meta[$fp] ?? null) ? $meta[$fp] : [];
            $entry = [
                'fingerprint' => $fp,
                'host' => (string)($row['host'] ?? ''),
                'subject' => (string)($row['subject'] ?? ''),
                'issuer' => (string)($row['issuer'] ?? ''),
                'from' => (string)($row['from'] ?? ''),
                'to' => (string)($row['to'] ?? ''),
                'pinned_at' => (int)($row['pinned_at'] ?? 0),
                'expires_ts' => (int)($row['expires_ts'] ?? 0),
            ];
            // A bundle that arrived by hand has no sidecar row: read the
            // certificate itself when openssl is there to do it.
            if (($entry['subject'] === '' || $entry['to'] === '') && function_exists('openssl_x509_parse')) {
                $parsed = @openssl_x509_parse($pem);
                if (is_array($parsed)) {
                    if ($entry['subject'] === '') { $entry['subject'] = self::dnLabel($parsed['subject'] ?? ''); }
                    if ($entry['issuer'] === '') { $entry['issuer'] = self::dnLabel($parsed['issuer'] ?? ''); }
                    if (!empty($parsed['validTo_time_t'])) {
                        $entry['expires_ts'] = (int)$parsed['validTo_time_t'];
                        if ($entry['to'] === '') { $entry['to'] = gmdate('Y-m-d', $entry['expires_ts']); }
                    }
                    if ($entry['from'] === '' && !empty($parsed['validFrom_time_t'])) {
                        $entry['from'] = gmdate('Y-m-d', (int)$parsed['validFrom_time_t']);
                    }
                }
            }
            $entry['expired'] = $entry['expires_ts'] > 0 ? ($entry['expires_ts'] < time()) : null;
            // Whole days left, null when the expiry is unknown. "Expiring" is a
            // separate flag from "expired": a certificate that already ran out
            // is refused, not warned about.
            $entry['days_left'] = $entry['expires_ts'] > 0
                ? (int)floor(($entry['expires_ts'] - time()) / 86400)
                : null;
            $entry['expiring'] = $entry['days_left'] !== null
                && $entry['days_left'] >= 0
                && $entry['days_left'] <= self::EXPIRY_WARN_DAYS;
            $out[] = $entry;
        }
        usort($out, function ($a, $b) {
            $at = $a['expires_ts'] > 0 ? $a['expires_ts'] : PHP_INT_MAX;
            $bt = $b['expires_ts'] > 0 ? $b['expires_ts'] : PHP_INT_MAX;
            if ($at === $bt) { return strcmp($a['fingerprint'], $b['fingerprint']); }
            return $at < $bt ? -1 : 1;
        });
        return $out;
    }

    /**
     * Remove one certificate from the bundle by fingerprint.
     *
     * The file is rewritten without that block, and the sidecar row goes with
     * it. Removing the last certificate deletes the bundle instead of leaving an
     * empty file: an empty CAINFO makes curl fail every call, and a missing file
     * simply means "nothing pinned".
     */
    public static function forget($fingerprint) {
        $fp = strtoupper(trim((string)$fingerprint));
        if ($fp === '') { return ['ok' => false, 'error' => 'fingerprint is required']; }
        $file = self::pinsPath();
        $blocks = self::pinnedFingerprints($file);
        if (!isset($blocks[$fp])) {
            return ['ok' => false, 'error' => 'That certificate is not pinned.'];
        }
        unset($blocks[$fp]);
        if (!$blocks) {
            @unlink($file);
            @unlink(self::metaPath());
            return ['ok' => true, 'removed' => 1, 'remaining' => 0, 'bundle' => $file];
        }
        if (@file_put_contents($file, rtrim(implode('', array_values($blocks))) . "\n", LOCK_EX) === false) {
            return ['ok' => false, 'error' => 'Could not write ' . $file];
        }
        $meta = self::pinMeta();
        unset($meta[$fp]);
        if ($meta) { @file_put_contents(self::metaPath(), json_encode($meta, JSON_PRETTY_PRINT), LOCK_EX); }
        else { @unlink(self::metaPath()); }
        return ['ok' => true, 'removed' => 1, 'remaining' => count($blocks), 'bundle' => $file];
    }
}
