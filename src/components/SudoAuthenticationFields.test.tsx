import { act, useState } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { render, flush } from '../testing/render';
import { SudoAuthenticationFields } from './SudoAuthenticationFields';
import { checkPowerAuth, getSudoPasswordStatus, saveSudoPassword, forgetSudoPassword } from '../api/client';
vi.mock('../api/client', () => ({ checkPowerAuth: vi.fn(), getSudoPasswordStatus: vi.fn(), saveSudoPassword: vi.fn(), forgetSudoPassword: vi.fn() }));
const targets = [{ id: 'a', name: 'DGX A' }];
function Harness({ targetList = targets }: { targetList?: typeof targets }) {
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const [ready, setReady] = useState(false);
  return <><SudoAuthenticationFields targets={targetList} disabled={false} onChange={setPasswords} onReady={setReady}/><output>{ready ? 'ready' : 'blocked'}:{Object.keys(passwords).length}</output></>;
}
function button(text: string) { return [...document.querySelectorAll('button')].find(b => b.textContent === text)!; }
function type(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[type="password"]')!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
beforeEach(() => {
  vi.mocked(getSudoPasswordStatus).mockResolvedValue({ hasPassword: false });
  vi.mocked(checkPowerAuth).mockResolvedValue({ status: 'password_required', hasPassword: false });
  vi.mocked(saveSudoPassword).mockResolvedValue({ hasPassword: true });
  vi.mocked(forgetSudoPassword).mockResolvedValue({ hasPassword: false });
});
it('requires validation, passes one-use credentials without saving, and invalidates validation on edit', async () => {
  render(<Harness/>); await flush();
  expect(document.querySelector('output')?.textContent).toBe('blocked:0');
  type('secret');
  vi.mocked(checkPowerAuth).mockResolvedValue({ status: 'ready', target: 'a-target', hasPassword: false });
  act(() => button('Verify permissions').click()); await flush();
  expect(checkPowerAuth).toHaveBeenLastCalledWith('a', 'secret');
  expect(saveSudoPassword).not.toHaveBeenCalled();
  expect(document.querySelector('output')?.textContent).toBe('ready:1');
  type('changed'); await flush();
  expect(document.querySelector('output')?.textContent).toBe('blocked:1');
});
it('explicit saving clears the typed secret and forgetting removes the saved credential', async () => {
  render(<Harness/>); await flush(); type('secret');
  vi.mocked(checkPowerAuth).mockResolvedValue({ status: 'ready', target: 'a-target', hasPassword: true });
  act(() => button('Verify and save encrypted').click()); await flush();
  expect(saveSudoPassword).toHaveBeenCalledWith('a', 'secret');
  expect(document.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe('');
  expect(document.querySelector('output')?.textContent).toBe('ready:0');
  vi.mocked(checkPowerAuth).mockResolvedValue({ status: 'password_required', hasPassword: false });
  act(() => button('Forget saved sudo password').click()); await flush();
  expect(forgetSudoPassword).toHaveBeenCalledWith('a');
  expect(document.querySelector('output')?.textContent).toBe('blocked:0');
});
it('missing system command remains a distinct blocking error', async () => {
  vi.mocked(checkPowerAuth).mockResolvedValue({ status: 'command_missing', hasPassword: false, error: 'systemctl is not available on this device' });
  render(<Harness/>); await flush();
  expect(document.body.textContent).toContain('systemctl is not available on this device');
  expect(document.querySelector('output')?.textContent).toBe('blocked:0');
});

it('discards an old authentication result after targets change', async () => {
  const { root } = render(<Harness/>); await flush(); type('first-device-secret');
  let finish!: (value: Awaited<ReturnType<typeof checkPowerAuth>>) => void;
  vi.mocked(checkPowerAuth).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  act(() => button('Verify permissions').click()); await flush();
  act(() => root.render(<Harness targetList={[{ id: 'b', name: 'DGX B' }]}/>)); await flush();
  await act(async () => finish({ status: 'ready', hasPassword: false, target: 'a-target' }));
  expect(document.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe('');
  expect(document.querySelector('output')?.textContent).toBe('blocked:0');
  expect(document.body.textContent).toContain('DGX B');
});

it('closing while status loads does not start a remote authentication check', async () => {
  let finish!: (value: { hasPassword: boolean }) => void;
  vi.mocked(getSudoPasswordStatus).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { root } = render(<Harness/>); await flush();
  act(() => root.render(null));
  await act(async () => finish({ hasPassword: false }));
  expect(checkPowerAuth).not.toHaveBeenCalled();
});
