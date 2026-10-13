const byId = (id) => document.getElementById(id);
let kind = 'pdf';
let submissionId;
let busy = false;
function status(message) { byId('form-status').textContent = message; }
function choose(value) {
  if (busy || submissionId) return;
  kind = value;
  byId('pdf-input').hidden = value !== 'pdf';
  byId('text-input').hidden = value !== 'text';
  byId('choose-pdf').setAttribute('aria-pressed', String(value === 'pdf'));
  byId('choose-text').setAttribute('aria-pressed', String(value === 'text'));
}
byId('choose-pdf').addEventListener('click', () => choose('pdf'));
byId('choose-text').addEventListener('click', () => choose('text'));
byId('submission-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 40000) return status('Use a text file no larger than 40 KB.');
  const text = await file.text();
  if (text.length > 10000) return status('Text must be no more than 10,000 characters.');
  byId('submission').value = text;
});
function validateInput() {
  if (kind === 'pdf') {
    const file = byId('resume').files[0];
    if (!file || !file.name.toLowerCase().endsWith('.pdf') || file.size > 5 * 1024 * 1024) throw new Error('Choose a PDF no larger than 5 MB.');
  } else if (byId('submission').value.trim().length < 20) throw new Error('Enter at least 20 characters to investigate.');
}
byId('investigation-form').addEventListener('submit', (event) => {
  event.preventDefault();
  try { validateInput(); byId('email-step').hidden = false; byId('deploy').hidden = true; byId('work-email').focus(); status('Your report will be sent to the work email you enter.'); }
  catch (error) { status(error.message); }
});
async function api(path, value) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const result = await response.json().catch(() => ({ error: 'Investigations are temporarily unavailable.' }));
  if (!response.ok) throw new Error(result.error || 'TraceDog is temporarily unavailable.');
  return result;
}
byId('send-report').addEventListener('click', async () => {
  if (busy) return;
  busy = true; byId('send-report').disabled = true;
  try {
    validateInput();
    if (!byId('work-email').value || !byId('work-email').checkValidity()) throw new Error('Enter a valid work email.');
    const domain = byId('work-email').value.toLowerCase().split('@')[1];
    const personalDomains = await fetch('/email-domains.json').then((response) => response.json());
    if (personalDomains.includes(domain) || /(?:^|\.)(?:gmail|yahoo|hotmail|outlook|mailinator|guerrillamail)\./.test(domain)) throw new Error('Enter your work email. Personal email addresses are not accepted.');
    const value = { kind, email: byId('work-email').value, consent: true, website: byId('website').value };
    if (kind === 'text') value.text = byId('submission').value;
    else {
      const bytes = new Uint8Array(await byId('resume').files[0].arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      value.pdf = btoa(binary);
    }
    status('Starting your investigation…');
    const result = await api('/api/submissions', value);
    submissionId = result.submissionId;
    byId('email-step').hidden = true;
    status(result.message);
  } catch (error) { status(error.message); }
  finally { busy = false; byId('send-report').disabled = false; }
});
