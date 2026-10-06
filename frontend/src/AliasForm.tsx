import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
    <form onSubmit={submit} className="grid gap-2">
      <Label htmlFor="alias">Choose an alias</Label>
      <Input id="alias" placeholder="my-alias" value={alias} onChange={(e) => setAlias(e.target.value)} autoFocus />
      <Button type="submit">Play</Button>
      {message && (
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      )}
    </form>
  );
}
