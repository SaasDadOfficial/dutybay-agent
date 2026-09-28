const btn = document.getElementById('loginBtn');
const err = document.getElementById('err');

btn.addEventListener('click', async () => {
  err.textContent = '';
  const serverUrl = 'http://127.0.0.1:8000/';
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;

  if (!serverUrl || !email || !password) {
    err.textContent = 'Please fill in all fields.';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Logging in...';

  const result = await window.agent.login(serverUrl, email, password);

  btn.disabled = false;
  btn.textContent = 'Log In';

  if (!result.ok) {
    err.textContent = result.message || 'Login failed. Check your details and try again.';
  }
  // On success, main process switches to the main tracker window.
});
