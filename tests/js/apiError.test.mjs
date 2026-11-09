/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// The armed-with-no-token state answers 503 on every route, so the UI has to
// recognise the failure rather than read a status body. Both the Config status
// line and the Permissions hint use this one predicate; these cases pin it.

import { isNoTokenError } from '../../ui/js/apiError.js?v=428';

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}`); }
}

console.log('api error tests');
console.log('-'.repeat(60));

const err = (status, body) => ({ status, data: body });

ok(isNoTokenError(err(503, { error: 'no token configured' })), 'the 503 body is recognised');
ok(isNoTokenError(err(503, { error: 'No Token Configured' })), 'the match ignores case');
ok(!isNoTokenError(err(503, { error: 'upstream unavailable' })), 'another 503 is not misread');
ok(!isNoTokenError(err(503, {})), 'a 503 with no error field is not misread');
ok(!isNoTokenError(err(401, { error: 'unauthorized' })), 'a 401 is not the no-token state');
ok(!isNoTokenError(err(403, { error: 'local requests only' })), 'a 403 is not the no-token state');
ok(!isNoTokenError({ status: 503 }), 'an error with no body is not misread');
ok(!isNoTokenError(null), 'null is not an error');
ok(!isNoTokenError(undefined), 'undefined is not an error');

console.log('-'.repeat(60));
console.log(`apiError: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
