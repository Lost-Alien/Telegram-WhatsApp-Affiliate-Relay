import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboard } from '../src/dashboard.js';

test('monitor is password-free and health reports connection readiness',async t=>{
  const server=await dashboard({host:'127.0.0.1',port:0},()=>({ready:false,queue:{pending:1}}),{});t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const page=await fetch(base);assert.equal(page.status,200);assert.equal(page.headers.get('www-authenticate'),null);assert.ok(!(await page.text()).includes('type="password"'));
  const status=await fetch(base+'/api/status');assert.equal(status.status,200);assert.equal((await status.json()).queue.pending,1);
  assert.equal((await fetch(base+'/healthz')).status,503);assert.equal((await fetch(base+'/arbitrary')).status,404);
});
