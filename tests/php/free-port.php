<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

/**
 * A loopback port for THIS test file's own server.
 *
 * A helper, not a test: it does not match `*.test.php`, so the runner does not
 * run it -- the same arrangement as mcp-mock-server.php. It is required by the
 * three files that start a server (guards, apacheGuards, secrets), which each
 * carried their own copy of it until the suite began running files at the same
 * time. Three copies of a port allocator is one thing when one file runs at a
 * time; concurrently they are three files competing for the same resource with
 * no idea the others exist.
 *
 * So this is deliberately NOT `tcp://127.0.0.1:0` any more, and that is the
 * whole point. Asking the OS to pick means the number goes back in its pool the
 * instant the socket closes, so two files starting servers in the same moment
 * can be handed the same one -- and the second server is then either unable to
 * bind or, worse, is answering requests meant for the other file's server.
 * Serially that never showed up, because there was never a second file.
 *
 * The walk therefore starts at a number derived from this process's own pid,
 * which no other file in the run is looking at, and stops at the first port
 * that actually binds -- which is then closed again immediately, because the
 * caller needs to bind it itself. 21000 + (pid % 4000) keeps the whole walk
 * (200 tries past the base) below 32768, where Linux starts handing out
 * ephemeral ports and Windows 49152, so this does not compete with the ports
 * the rest of the machine is being given.
 *
 * It cannot make the handover atomic: between this socket closing and the
 * caller's server binding, another process could take the port. That is why
 * every caller still keeps its own retry loop -- this makes a collision between
 * two files of the same run unlikely rather than certain, and the retry covers
 * the rest. 0 means nothing bound, which callers report as a SKIP: a machine
 * with no free loopback port is an environment to describe, not a failure.
 */
function free_port()
{
    $base = 21000 + (getmypid() % 4000);
    for ($port = $base; $port < $base + 200; $port++) {
        $sock = @stream_socket_server('tcp://127.0.0.1:' . $port, $errno, $errstr);
        if ($sock) {
            fclose($sock);
            return $port;
        }
    }
    return 0;
}
