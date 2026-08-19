const dotenv = require('dotenv');
dotenv.config({ path: '/storage/emulated/0/PROJECTS/yours/backend/yours-backend/.env' });
(async () => {
  const key = process.env.DEAPI_API_KEY1;
  const refUrl = 'https://pub-475cca0b7414418d866128a4b30dfd97.r2.dev/images/yours/Characters/dedb7542b68bf2e13c410b256a5398b7.jpg';
  const imgRes = await fetch(refUrl);
  const buf = Buffer.from(await imgRes.arrayBuffer());
  const form = new FormData();
  form.append('model', 'QwenImageEdit_Plus_NF4');
  form.append('image', new Blob([new Uint8Array(buf)], { type: 'image/jpeg' }), 'portrait.jpg');
  form.append('prompt', 'Edit this portrait. New pose, new outfit, new environment, same face and body. Portrait orientation.');
  form.append('steps', '25'); form.append('guidance', '7.5'); form.append('seed', '-1');

  const resp = await fetch('https://api.deapi.ai/api/v1/client/img2img', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    body: form,
    signal: AbortSignal.timeout(60000)
  });
  const submit = await resp.json();
  console.log('submit status:', resp.status, JSON.stringify(submit));
  const rid = submit.data && submit.data.request_id;
  if (!rid) { process.exit(1); }

  // Try both candidate poll endpoints
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 4000));
    let found = null;
    for (const path of [`/api/v1/request-status/${rid}`, `/api/v2/jobs/${rid}`]) {
      try {
        const pr = await fetch('https://api.deapi.ai' + path, {
          headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(15000)
        });
        const pj = await pr.json();
        const st = pj.status || (pj.data && pj.data.status) || '';
        console.log(`poll ${i} ${path} -> http ${pr.status} status=${st} body=${JSON.stringify(pj).slice(0,300)}`);
        if (st === 'done' || st === 'error' || st === 'failed') { found = pj; break; }
      } catch (e) { console.log(`poll ${i} ${path} ERR:`, e.message); }
    }
    if (found) { console.log('FINAL:', JSON.stringify(found).slice(0, 600)); process.exit(0); }
  }
  console.log('never done');
  process.exit(1);
})();
