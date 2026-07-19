import { Component } from '@angular/core';
import { ConnectPanel } from './connect-panel/connect-panel';
import { NodeList } from './node-list/node-list';
import { TransferList } from './transfer-list/transfer-list';

@Component({
  selector: 'app-root',
  imports: [ConnectPanel, NodeList, TransferList],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {}
