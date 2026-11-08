<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// The exact request each agent sent, kept for inspection.
namespace Src;

/**
 * A ring of the last requests this server posted, in storage/sent.json.
 *
 * Why this exists: "did the app send a tools array?" was unanswerable from the
 * app. The body is assembled twice -- the browser's spec, then Harness::payload
 * on the server -- so no screenshot of an agent's settings, and no reply,
 * distinguishes a request that offered no schemas from a model that ignored
 * the ones it was given. Those are opposite problems with the same symptom.
 *
 * The whole payload is kept, because the payload IS the answer: a summary that
 * drops the message bodies cannot show a prompt that taught no tools. It is
 * bounded instead -- MAX entries, each body cut at PAYLOAD_MAX -- so twenty of
 * them can never grow without limit.
 *
 * No secret reaches here. The API key travels in a header, never the body, and
 * the endpoint's query string (where Google puts ?key=) is stripped on the way
 * in, so a saved record is safe to show in a dialog.
 */
class SentLog
{
    /** How many requests the ring keeps. */
    public const MAX = 20;

    /** Bytes of payload JSON kept per entry. */
    public const PAYLOAD_MAX = 120000;

    private static $path = __DIR__ . '/../storage/sent.json';

    /** Point the ring at another file. Tests use it; nothing else should. */
    public static function usePath($path)
    {
        self::$path = (string)$path;
    }

    public static function path()
    {
        return self::$path;
    }

    /**
     * Record one request.
     *
     * $spec is what the browser asked for (agent, provider, model), $payload the
     * body Harness actually built, $endpoint where it went and $family the
     * harness that shaped it. Both halves are kept: the spec says what was
     * intended, the payload what was sent.
     */
    public static function record(array $spec, array $payload, $endpoint, $family)
    {
        $json = (string)json_encode($payload);
        $truncated = strlen($json) > self::PAYLOAD_MAX;
        if ($truncated) {
            $json = substr($json, 0, self::PAYLOAD_MAX);
        }

        $entry = array(
            'at' => time(),
            'agent' => (string)($spec['agent_id'] ?? ''),
            'provider' => (string)($spec['provider'] ?? ''),
            'family' => (string)$family,
            'model' => (string)($payload['model'] ?? ($spec['model'] ?? '')),
            'endpoint' => self::cleanEndpoint($endpoint),
            // The schema names, which is the list a reader actually checks: a
            // count alone cannot say whether read_file was offered.
            'tools' => self::toolNames($payload['tools'] ?? null),
            'toolChoice' => $payload['tool_choice'] ?? null,
            // Roles only: the bodies are in payload, and repeating them would
            // double the size of every record for nothing.
            'roles' => self::roles($payload['messages'] ?? null),
            'bytes' => strlen($json),
            'truncated' => $truncated,
            'payload' => $json,
        );

        self::push($entry);
        return $entry;
    }

    /** Newest first, at most $limit entries. */
    public static function read($limit = self::MAX)
    {
        $limit = max(1, (int)$limit);
        $rows = self::load();
        $rows = array_reverse($rows);
        return array(
            'max' => self::MAX,
            'requests' => array_slice($rows, 0, $limit),
        );
    }

    public static function clear()
    {
        self::rewrite(array());
    }

    private static function rewrite(array $rows)
    {
        self::mutate(function () use ($rows) {
            return $rows;
        });
    }

    /** Append and trim, both inside the same lock. */
    private static function push(array $entry)
    {
        self::mutate(function (array $rows) use ($entry) {
            $rows[] = $entry;
            if (count($rows) > self::MAX) {
                $rows = array_slice($rows, -self::MAX);
            }
            return $rows;
        });
    }

    /**
     * Read, change and write the ring while holding an exclusive lock.
     *
     * A fan-out is the normal case here -- several agents finish at once and
     * every one of them records its request -- so a plain read-modify-write
     * loses entries and can leave a half-written file. The lock is taken on the
     * data file itself, which is also what makes the rewrite atomic for a
     * reader: it sees the old array or the new one, never a truncated middle.
     */
    private static function mutate(callable $change)
    {
        $dir = dirname(self::$path);
        if (!is_dir($dir)) {
            @mkdir($dir, 0777, true);
        }
        $fh = @fopen(self::$path, 'c+');
        if ($fh === false) {
            return array();   // a read-only install still serves; only the record is lost
        }
        if (!flock($fh, LOCK_EX)) {
            fclose($fh);
            return array();
        }
        $rows = $change(self::decode((string)stream_get_contents($fh)));
        if (!is_array($rows)) {
            $rows = array();
        }
        if (ftruncate($fh, 0)) {
            rewind($fh);
            fwrite($fh, (string)json_encode($rows));
            fflush($fh);
        }
        flock($fh, LOCK_UN);
        fclose($fh);
        return $rows;
    }

    private static function load()
    {
        if (!is_file(self::$path)) {
            return array();
        }
        $fh = @fopen(self::$path, 'r');
        if ($fh === false) {
            return array();
        }
        flock($fh, LOCK_SH);
        $raw = (string)stream_get_contents($fh);
        flock($fh, LOCK_UN);
        fclose($fh);
        return self::decode($raw);
    }

    /** Anything that is not a JSON array of objects reads as empty, never fatal. */
    private static function decode($raw)
    {
        if ($raw === '') {
            return array();
        }
        $rows = json_decode($raw, true);
        if (!is_array($rows)) {
            return array();
        }
        $out = array();
        foreach ($rows as $row) {
            if (is_array($row)) {
                $out[] = $row;
            }
        }
        return $out;
    }

    /** OpenAI, Anthropic and Ollama tool shapes all name the tool one level in. */
    private static function toolNames($tools)
    {
        if (!is_array($tools)) {
            return array();
        }
        $names = array();
        foreach ($tools as $tool) {
            if (is_string($tool)) {
                $names[] = $tool;
            } elseif (is_array($tool)) {
                if (isset($tool['function']['name'])) {
                    $names[] = (string)$tool['function']['name'];
                } elseif (isset($tool['name'])) {
                    $names[] = (string)$tool['name'];
                }
            }
        }
        return $names;
    }

    private static function roles($messages)
    {
        if (!is_array($messages)) {
            return array();
        }
        $roles = array();
        foreach ($messages as $message) {
            if (is_array($message)) {
                $roles[] = (string)($message['role'] ?? '?');
            }
        }
        return $roles;
    }

    /** Drop the query string and any credentials it might carry. */
    private static function cleanEndpoint($url)
    {
        $url = (string)$url;
        $cut = strcspn($url, '?#');
        return substr($url, 0, $cut);
    }
}
