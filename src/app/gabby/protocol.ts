/**
 * TypeScript mirror of the gabby backend protocol
 * (io.cutehat.gabby.api.protocol).
 */

/**
 * Fallback chunk size used until the server's POLICY response arrives (or if
 * it never does). The server relays whole binary frames and its websocket
 * container caps a binary frame at 65,536 bytes; frames carry raw chunk data
 * only since each client has at most one active transfer, so the server
 * resolves the transfer from the sender alone. Kept below the cap because
 * permessage-deflate can expand incompressible chunks by a few bytes on the
 * wire.
 */
export const CHUNK_DATA_SIZE = 63 * 1024;

export const MAX_FILE_SIZE = 1_000_000_000;

export type ClientCommandType =
  | 'REGISTER'
  | 'DEREGISTER'
  | 'SEND_PAYLOAD_REQ'
  | 'ACCEPT_PAYLOAD_REQ'
  | 'REJECT_PAYLOAD_REQ'
  | 'GET_POLICY';

export type ServerMessageType = 'NODE_LIST' | 'TRANSFER_LIST' | 'POLICY';

export type TransferStatus =
  | 'REQUESTED'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'IN_PROGRESS'
  | 'COMPLETED_WITH_ERROR'
  | 'COMPLETED_SUCCESSFULLY';

export interface ClientCommand {
  clientCommandType: ClientCommandType;
  payload: unknown;
}

export interface ServerMessage {
  messageType: ServerMessageType;
  payload: unknown;
}

export interface NodeDto {
  name: string;
  joinedAt: string;
}

export interface FileMeta {
  name: string;
  sizeInBytes: number;
  mimeType: string;
}

export interface TransferDto {
  id: string;
  status: TransferStatus;
  from: string;
  to: string;
  fileMeta: FileMeta;
  validUntil: string;
}

export interface SendPayloadReq {
  to: string;
  fileMeta: FileMeta;
}

export interface TransferActionReq {
  transferId: string;
}

export interface PolicyDto {
  maxChunkSizeInBytes: number;
}
