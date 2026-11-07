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
        return ($path !== '' && is_file($path) && is_readable($path)) ? $path : '';
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
}
