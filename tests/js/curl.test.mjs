// Shell + curl + JSON API parsing tests.
import { parseCurl, substituteCurlTemplate } from '../../ui/js/curlParser.js?v=303';

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) pass++; else { fail++; console.error('FAIL:', name); } };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// Shell snippet with heredoc JSON body and shell variables for URL/key.
const shell = `invoke_url='https://api.example.com/v1/chat/completions'
KEY='sk-12345'
payload=$(cat <<'EOF'
{ "model": "m", "messages": [{"role":"user","content":"hello"}], "temperature": 0.2 }
EOF
)
curl -sS -N --request POST --url "$invoke_url" \
     --header "Authorization: Bearer $KEY" --data "$payload"`;

const parsed = parseCurl(shell);
ok(parsed.url === 'https://api.example.com/v1/chat/completions', 'shell url resolved');
ok(parsed.headers && parsed.headers['Authorization'] === 'Bearer sk-12345', 'shell key resolved');
eq(JSON.parse(parsed.data).messages[0].content, 'hello', 'shell heredoc body resolved');

// Substitute template with Router Studio vars.
const tpl = 'curl $ENDPOINT-VARIABLE -H "Authorization: Bearer $GENERATED-API-KEY-VARIABLE" -d \'{"messages":[{"role":"user","content":"$USER-PROMPT-VARIABLE"}], "temperature": $TEMP}\'';
const { text, restore } = substituteCurlTemplate(tpl, {
  endpoint: 'https://host/v1', apiKey: 'k1', prompt: 'say hi', temperature: 0.5,
});
const out = restore(text);
ok(out.includes('https://host/v1'), 'endpoint substituted');
ok(out.includes('Bearer k1'), 'key substituted');
ok(out.includes('say hi'), 'prompt substituted');
ok(out.includes('"temperature": 0.5'), 'temp substituted');

console.log(`Shell/JSON parse tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
