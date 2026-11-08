<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

/**
 * The outgoing-request ring (src/SentLog.php).
 *
 * Usage: php tests/php/sentLog.test.php
 *
 * The Sent view exists to answer one question the app could not: did this turn
 * actually carry a tools array, and which schemas were in it? These checks pin
 * the record down -- the payload is kept (and bounded), the schema names are
 * listed, a query string never survives (Google's ?key= lives there), and the
 * store is a ring rather than a growing log.
 *
 * Exits 0 on success, 1 on any failure.
 */

$root = dirname(__DIR__, 2);
require $root . '/autoload.php';

use Src\SentLog;

$pass = 0;
$fail = 0;
$errors = array();

function ok($cond, $name)
{
    global $pass, $fail, $errors;
    if ($cond) {
        $pass++;
        return true;
    }
    $fail++;
    $errors[] = 'FAIL: ' . $name;
    return false;
}

echo "SentLog tests\n";
echo str_repeat('-', 60) . "\n";

$tmp = rtrim(str_replace('\\', '/', sys_get_temp_dir()), '/') . '/router-sent-' . getmypid();
if (!is_dir($tmp)) {
    @mkdir($tmp, 0777, true);
}
SentLog::usePath($tmp . '/sent.json');
SentLog::clear();

// --- one ordinary OpenAI-compatible request --------------------------------
$spec = array('agent_id' => 'a1', 'provider' => 'lmstudio', 'model' => 'qwen');
$payload = array(
    'model' => 'qwen',
    'messages' => array(
        array('role' => 'system', 'content' => 'you are an agent'),
        array('role' => 'user', 'content' => 'list the files'),
    ),
    'temperature' => 0.7,
    'stream' => true,
    'tools' => array(array(
        'type' => 'function',
        'function' => array('name' => 'read_file', 'parameters' => array('type' => 'object')),
    )),
    'tool_choice' => 'auto',
);
$entry = SentLog::record($spec, $payload, 'http://localhost:1234/v1/chat/completions?key=SECRET', 'openai');

ok($entry['family'] === 'openai', 'the harness family is recorded');
ok($entry['agent'] === 'a1', 'the agent is recorded');
ok($entry['model'] === 'qwen', 'the model comes from the body');
ok($entry['tools'] === array('read_file'), 'the schema names are recorded, not just a count');
ok($entry['toolChoice'] === 'auto', 'tool_choice is recorded');
ok($entry['roles'] === array('system', 'user'), 'the message roles are recorded');
ok($entry['endpoint'] === 'http://localhost:1234/v1/chat/completions',
    'the query string is stripped from the endpoint');
ok(strpos((string)$entry['payload'], 'read_file') !== false,
    'the body itself is kept, tools included');
ok($entry['truncated'] === false, 'a small body is not marked truncated');

// --- a request that offered nothing ---------------------------------------
$plain = SentLog::record(
    array('agent_id' => 'a2'),
    array('model' => 'llama', 'messages' => array()),
    'https://example.test/api/chat',
    'ollama'
);
ok($plain['tools'] === array(), 'a request with no tools records an empty list');
ok($plain['toolChoice'] === null, 'and no tool_choice');

// --- the ring, not a log ---------------------------------------------------
for ($i = 0; $i < SentLog::MAX + 5; $i++) {
    SentLog::record(
        array('agent_id' => 'ring' . $i),
        array('model' => 'm', 'messages' => array()),
        'http://h/v1/chat/completions',
        'openai'
    );
}
$read = SentLog::read();
ok(count($read['requests']) === SentLog::MAX, 'the ring keeps only MAX entries');
ok($read['max'] === SentLog::MAX, 'and reports its own bound');
ok($read['requests'][0]['agent'] === 'ring' . (SentLog::MAX + 4), 'newest is first');
ok($read['requests'][0]['at'] > 0, 'every entry is timestamped');

// --- an oversized body is cut, and says so --------------------------------
$huge = array(
    'model' => 'm',
    'messages' => array(),
    'blob' => str_repeat('x', SentLog::PAYLOAD_MAX + 10),
);
$big = SentLog::record(array('agent_id' => 'big'), $huge, 'http://h/', 'openai');
ok($big['truncated'] === true, 'an oversized body is flagged');
ok(strlen((string)$big['payload']) === SentLog::PAYLOAD_MAX, 'and cut at the cap');

// --- clearing and a corrupt file ------------------------------------------
SentLog::clear();
ok(count(SentLog::read()['requests']) === 0, 'clear empties the ring');

@file_put_contents($tmp . '/sent.json', 'not json at all');
ok(SentLog::read()['requests'] === array(), 'a corrupt file reads as nothing rather than fataling');

@unlink($tmp . '/sent.json');
@rmdir($tmp);

foreach ($errors as $line) {
    echo $line . "\n";
}
echo "{$pass} passed, {$fail} failed\n";
exit($fail === 0 ? 0 : 1);
