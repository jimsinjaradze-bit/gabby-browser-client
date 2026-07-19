import { Component, inject, signal } from '@angular/core';
import { GabbyClientService } from '../gabby/gabby-client.service';

const SERVER_URL = 'wss://gabby-app-raicg.ondigitalocean.app/ws';
const NAME_KEY = 'gabby.name';

// localStorage is missing in the jsdom test environment
function readStored(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // best effort only
  }
}

const STATUS_LABELS = {
  disconnected: 'off air',
  connecting: 'dialing…',
  connected: 'on air',
} as const;

@Component({
  selector: 'app-connect-panel',
  templateUrl: './connect-panel.html',
  styleUrl: './connect-panel.css',
})
export class ConnectPanel {
  protected readonly client = inject(GabbyClientService);

  protected readonly name = signal(readStored(NAME_KEY) ?? '');

  protected statusLabel(): string {
    return STATUS_LABELS[this.client.connectionState()];
  }

  protected connect(event: Event): void {
    event.preventDefault();
    writeStored(NAME_KEY, this.name());
    this.client.connect(SERVER_URL, this.name());
  }
}
