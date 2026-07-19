import { Component, inject } from '@angular/core';
import { GabbyClientService, TransferView } from '../gabby/gabby-client.service';
import { formatBytes } from '../gabby/format';
import { critterFor } from '../gabby/avatar';

const PHASE_LABELS: Record<TransferView['phase'], string> = {
  'awaiting-accept': 'awaiting accept',
  expired: 'expired',
  rejected: 'declined',
  sending: 'in flight',
  receiving: 'incoming',
  done: 'delivered',
  failed: 'lost',
};

@Component({
  selector: 'app-transfer-list',
  templateUrl: './transfer-list.html',
  styleUrl: './transfer-list.css',
})
export class TransferList {
  protected readonly client = inject(GabbyClientService);
  protected readonly formatBytes = formatBytes;
  protected readonly critterFor = critterFor;

  protected phaseLabel(view: TransferView): string {
    return PHASE_LABELS[view.phase];
  }

  protected showProgress(view: TransferView): boolean {
    return view.phase === 'sending' || view.phase === 'receiving' || view.phase === 'done';
  }
}
