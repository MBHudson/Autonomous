<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

/**
 * Documentation guards: What's new holds one release, and every Contents link
 * lands on a heading.
 *
 * Usage: php tests/php/docs.test.php
 *
 * Both of these drifted by hand and nothing noticed:
 *
 *   - What's new grew into a second feature list. Eleven releases sat between
 *     the top of the README and the table that describes the app as it is now,
 *     and a feature described only there scrolled out of sight. The rule is now
 *     one release in that section: new work gets a row in What's inside (and a
 *     line under the matching Security rule), and the previous entry is folded
 *     into it when the next release lands. More than ONE release heading in
 *     What's new is therefore drift, and so is an entry that is not the version
 *     in VERSION.
 *
 *   - The Contents list is hand-written. Rename a heading and its link follows
 *     nothing: the anchor scrolls to the top of the page or does nothing at all,
 *     and a reader concludes the section is missing. Every link is resolved here
 *     against the real headings using GitHub's own slug rules, which are also
 *     asserted below -- a broken slugger would otherwise make every link "pass".
 *
 * Exits 0 on success, 1 on any failure.
 */

$root = dirname(__DIR__, 2);

$readme = @file_get_contents($root . '/README.md');
$versionFile = @file_get_contents($root . '/VERSION');

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

/**
 * GitHub's heading anchor: keep letters, combining marks (the variation
 * selector in an emoji survives), numbers, connector punctuation, hyphens and
 * spaces; drop everything else -- emoji, arrows, em dashes, quotes -- then turn
 * every space into a hyphen. No collapsing and no trimming: the space an emoji
 * leaves behind is what makes `### 🆕 What's new` become `-whats-new`, and an em
 * dash between two spaces is what makes `desktop--the` out of `Desktop — the`.
 */
function slug($text)
{
    $s = preg_replace('/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/u', '', $text);
    if ($s === null) {
        return '';
    }
    return strtolower(str_replace(' ', '-', $s));
}

/**
 * Every ATX heading in document order, with the byte offset it starts at.
 * Fenced code is skipped: the bash examples carry `#` comments that would
 * otherwise read as headings and quietly widen the anchor set.
 */
function headings($text)
{
    $out = array();
    $inFence = false;
    $offset = 0;
    foreach (preg_split('/(?<=\n)/', $text) as $line) {
        if (preg_match('/^\s*```/', $line)) {
            $inFence = !$inFence;
            $offset += strlen($line);
            continue;
        }
        if (!$inFence && preg_match('/^(#{1,6})\s+(.+?)\s*$/u', rtrim($line, "\r\n"), $m)) {
            $out[] = array('level' => strlen($m[1]), 'text' => $m[2], 'offset' => $offset);
        }
        $offset += strlen($line);
    }
    return $out;
}

/** The text of a section: from its heading to the next heading of level 1-2. */
function section_text($text, $headings, $heading)
{
    $end = strlen($text);
    foreach ($headings as $other) {
        if ($other['offset'] > $heading['offset'] && $other['level'] <= 2) {
            $end = $other['offset'];
            break;
        }
    }
    return substr($text, $heading['offset'], $end - $heading['offset']);
}

function heading_named($headings, $name)
{
    foreach ($headings as $h) {
        if ($h['text'] === $name) {
            return $h;
        }
    }
    return null;
}

echo "Documentation tests\n";
echo str_repeat('-', 60) . "\n";

ok(is_string($readme) && $readme !== '', 'README.md is readable');
ok(is_string($versionFile) && trim($versionFile) !== '', 'VERSION is readable');

if (!is_string($readme) || $readme === '') {
    echo str_repeat('-', 60) . "\n";
    echo "$pass passed, $fail failed\n";
    foreach ($errors as $e) {
        echo "  $e\n";
    }
    exit(1);
}

$headings = headings($readme);
$version = trim((string)$versionFile);

// --- the slugger, proven before it is trusted ------------------------------
ok(slug("🆕 What's new") === '-whats-new', 'slug: emoji dropped, apostrophe dropped, space kept as a hyphen');
ok(slug('🌐 8. Network egress is fenced (SSRF guardrails)') === '-8-network-egress-is-fenced-ssrf-guardrails',
    'slug: numbering and parentheses dropped');
ok(substr(slug('🎛️ Config → Desktop — the machine room card'), 3) === '-config--desktop--the-machine-room-card',
    'slug: arrow and em dash leave two hyphens, variation selector kept');
ok(slug('🧭 Contents') === '-contents', 'slug: a heading with nothing but an emoji and words');

// --- What's new: one release, and it is this one ---------------------------
$newsHeading = heading_named($headings, "🆕 What's new");
ok($newsHeading !== null, "What's new section exists");

if ($newsHeading !== null) {
    $news = section_text($readme, $headings, $newsHeading);
    $releases = array();
    foreach (headings($news) as $h) {
        if ($h['level'] === 3 && preg_match('/\bv(\d+)\b/u', $h['text'], $m)) {
            $releases[] = array('version' => (int)$m[1], 'text' => $h['text']);
        }
    }
    ok(count($releases) === 1, sprintf(
        "What's new holds exactly one release (found %d%s)",
        count($releases),
        $releases ? ': ' . implode(', ', array_map(function ($r) {
            return 'v' . $r['version'];
        }, $releases)) : ''
    ));
    if (count($releases) === 1) {
        ok($releases[0]['version'] === (int)$version, sprintf(
            "What's new describes VERSION %s (its entry is v%d: %s)",
            $version,
            $releases[0]['version'],
            $releases[0]['text']
        ));
    }
    // The intro points a reader at the two places the history now lives, so a
    // rewrite that forgets to is caught rather than quietly losing the trail.
    ok(stripos($news, "What's inside") !== false && stripos($news, 'Security') !== false,
        "What's new intro points at What's inside and Security");
}

// --- Contents: every link lands on a real heading --------------------------
$contentsHeading = heading_named($headings, '🧭 Contents');
ok($contentsHeading !== null, 'Contents section exists');

if ($contentsHeading !== null) {
    $contents = section_text($readme, $headings, $contentsHeading);

    $anchors = array();
    preg_match_all('/\[([^\]]+)\]\(#([^)\s]+)\)/u', $contents, $m, PREG_SET_ORDER);
    foreach ($m as $link) {
        $anchors[] = array('label' => $link[1], 'target' => $link[2]);
    }
    ok(count($anchors) > 40, sprintf('Contents lists more than 40 anchors (found %d)', count($anchors)));

    $slugs = array();
    foreach ($headings as $h) {
        $slugs[slug($h['text'])] = true;
    }

    $missing = array();
    foreach ($anchors as $a) {
        if (!isset($slugs[$a['target']])) {
            $missing[] = $a['label'] . ' -> #' . $a['target'];
        }
    }
    ok($missing === array(), sprintf(
        'every Contents anchor resolves to a heading (%d broken%s)',
        count($missing),
        $missing ? ': ' . implode(' | ', array_slice($missing, 0, 6)) : ''
    ));

    // The same anchor twice means one entry was duplicated while editing.
    $counts = array();
    foreach ($anchors as $a) {
        $counts[$a['target']] = ($counts[$a['target']] ?? 0) + 1;
    }
    $dupes = array_keys(array_filter($counts, function ($n) {
        return $n > 1;
    }));
    ok($dupes === array(), sprintf(
        'Contents has no duplicate anchors%s',
        $dupes ? ': #' . implode(', #', $dupes) : ''
    ));
}

echo str_repeat('-', 60) . "\n";
echo "$pass passed, $fail failed\n";
foreach ($errors as $e) {
    echo "  $e\n";
}
exit($fail ? 1 : 0);
