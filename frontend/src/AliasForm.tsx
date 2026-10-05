import { useState, type FormEvent } from 'react';
import { request } from './api';

const MESSAGES: Record<string, string> = {
  ALIAS_TAKEN: 'That alias is taken. Try another.',
  INVALID_ALIAS: 'Use 3 to 20 letters, digits, _ or -.',
};

export function AliasForm({ onJoined }: { onJoined: () => void }) {
  const [alias, setAlias] = useState('');
  const [message, setMessage] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    const res = await request('/player', { method: 'POST', body: JSON.stringify({ alias }) });
    const { error } = await res.json();
    // PLAYER_EXISTS means an earlier attempt already created this player.
    if (res.status === 201 || error === 'PLAYER_EXISTS') return onJoined();
    setMessage(MESSAGES[error] ?? 'Something went wrong. Try again.');
  }

  return (
    <form onSubmit={submit}>
      <label htmlFor="alias">Choose an alias</label>{' '}
      <input id="alias" value={alias} onChange={(e) => setAlias(e.target.value)} autoFocus />{' '}
      <button type="submit">Play</button>
      {message && <p role="alert">{message}</p>}
    </form>
  );
}
