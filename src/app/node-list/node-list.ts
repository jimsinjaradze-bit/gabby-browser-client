import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { GabbyClientService } from '../gabby/gabby-client.service';
import { MAX_FILE_SIZE } from '../gabby/protocol';
import { formatBytes } from '../gabby/format';
import { critterFor } from '../gabby/avatar';

@Component({
  selector: 'app-node-list',
  imports: [DatePipe],
  templateUrl: './node-list.html',
  styleUrl: './node-list.css',
})
export class NodeList {
  protected readonly client = inject(GabbyClientService);
  protected readonly selectedFiles = signal<Record<string, File>>({});
  protected readonly fileError = signal('');

  protected readonly formatBytes = formatBytes;
  protected readonly critterFor = critterFor;

  protected onFilePicked(peer: string, event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      this.fileError.set(`"${file.name}" is over the 1 GB limit.`);
      input.value = '';
      return;
    }
    this.fileError.set('');
    this.selectedFiles.update((files) => ({ ...files, [peer]: file }));
  }

  protected send(peer: string): void {
    const file = this.selectedFiles()[peer];
    if (!file) {
      return;
    }
    this.client.sendFileRequest(peer, file);
  }
}
