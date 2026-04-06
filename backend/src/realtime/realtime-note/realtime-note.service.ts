/*
 * SPDX-FileCopyrightText: 2025 The HedgeDoc developers (see AUTHORS file)
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { PermissionLevel } from '@hedgedoc/commons';
import { FieldNameRevision } from '@hedgedoc/database';
import { Optional } from '@mrdrogdrog/optional';
import { BeforeApplicationShutdown, Inject, Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { SchedulerRegistry } from '@nestjs/schedule';

import { BraidService } from '../../braid/braid.service';
import noteConfiguration, { NoteConfig } from '../../config/note.config';
import { NoteEvent } from '../../events';
import { ConsoleLoggerService } from '../../logger/console-logger.service';
import { PermissionService } from '../../permissions/permission.service';
import { RevisionsService } from '../../revisions/revisions.service';
import { RealtimeConnection } from './realtime-connection';
import { RealtimeNote } from './realtime-note';
import { RealtimeNoteStore } from './realtime-note-store';

@Injectable()
export class RealtimeNoteService implements BeforeApplicationShutdown {
  constructor(
    private revisionsService: RevisionsService,
    private readonly logger: ConsoleLoggerService,
    private realtimeNoteStore: RealtimeNoteStore,
    private schedulerRegistry: SchedulerRegistry,
    @Inject(noteConfiguration.KEY)
    private noteConfig: NoteConfig,
    private permissionService: PermissionService,
    private braidService: BraidService,
  ) {}

  /**
   * Cleans up all {@link RealtimeNote} instances before the application is shut down
   * This method is called by NestJS when the application is shutting down
   */
  beforeApplicationShutdown(): void {
    this.realtimeNoteStore.getAllRealtimeNotes().forEach((realtimeNote) => realtimeNote.destroy());
  }

  /**
   * Reads the current content from the given {@link RealtimeNote} and creates a new revision for the linked note.
   *
   * @param realtimeNote The realtime note for which a revision should be created
   */
  public saveRealtimeNote(realtimeNote: RealtimeNote): void {
    const wsDocText = realtimeNote.getRealtimeDoc().getCurrentContent();
    const encodedStateUpdate = realtimeNote.getRealtimeDoc().encodeStateAsUpdate();
    const encodedStateUpdateBytes = new Uint8Array(encodedStateUpdate);
    console.log(`[saveRealtimeNote] note ${realtimeNote.getNoteId()}: ws Y.Doc text="${wsDocText.slice(0, 50)}" (${wsDocText.length} chars), yjs state size=${encodedStateUpdateBytes.length}`);

    // Get braid version if available
    const noteId = realtimeNote.getNoteId();
    const braidText = this.braidService.getBraidText();
    const braidResource = braidText?.cache[noteId.toString()];

    const saveFn = async () => {
      const resource = braidResource ? await braidResource : null;
      const braidVersion = resource?.version?.length
        ? JSON.stringify(resource.version)
        : undefined;

      await this.revisionsService.createRevision(
        noteId,
        realtimeNote.getRealtimeDoc().getCurrentContent(),
        false,
        undefined,
        encodedStateUpdateBytes.buffer,
        braidVersion,
      );
      realtimeNote.announceMetadataUpdate();
    };

    saveFn().catch((reason) => this.logger.error(reason));
  }

  /**
   * Creates or reuses a {@link RealtimeNote} that is handling the real-time-editing of the note which is identified by the given note id
   *
   * @param noteId The id of the note for which a {@link RealtimeNote} should be retrieved
   * @returns A RealtimeNote that is linked to the given note.
   * @throws NotInDBError if note doesn't exist or has no revisions.
   */
  public async getOrCreateRealtimeNote(noteId: number): Promise<RealtimeNote> {
    return this.realtimeNoteStore.find(noteId) ?? (await this.createNewRealtimeNote(noteId));
  }

  /**
   * Creates a new {@link RealtimeNote} for the given note and registers event listeners
   * to persist the note periodically and before it is destroyed
   *
   * @param noteId The id of the note for which the realtime note should be created
   * @returns The created realtime note
   * @throws NotInDBError if the note doesn't exist or has no revisions
   */
  private async createNewRealtimeNote(noteId: number): Promise<RealtimeNote> {
    const lastRevision = await this.revisionsService.getLatestRevision(noteId);
    const realtimeNote = this.realtimeNoteStore.create(
      noteId,
      lastRevision[FieldNameRevision.content],
      lastRevision[FieldNameRevision.yjsStateVector]?.buffer ?? undefined,
    );
    realtimeNote.on('beforeDestroy', () => {
      this.saveRealtimeNote(realtimeNote);
    });
    this.startPersistTimer(realtimeNote);

    // Initialize braid-text resource from the same DB state
    await this.braidService.initBraidResource(noteId);

    // Set up two-way sync between hedgedoc's Y.Doc and braid-text
    const braidText = this.braidService.getBraidText();
    const key = noteId.toString();
    const realtimeDoc = realtimeNote.getRealtimeDoc();

    // WS → braid-text: when the ws-side Y.Doc gets an edit (from websocket clients),
    // forward the Yjs update to braid-text
    const wsUpdateHandler = (update: number[], origin: unknown) => {
      if (origin === 'braid-http') {
        console.log(`[ws→braid-text] note ${noteId}: skipping echo (origin=braid-http)`);
        return;
      }
      console.log(`[ws→braid-text] note ${noteId}: forwarding update size=${update.length} origin=${origin}`);
      braidText.put(key, {
        yjs_update: new Uint8Array(update),
        peer: 'ws',
      }).catch((e: Error) => {
        this.logger.error(`ws→braid-text failed for note ${noteId}: ${e.message}`);
      });
    };
    realtimeDoc.on('update', wsUpdateHandler);

    // Braid-text → WS: subscribe to braid-text for yjs-text updates,
    // convert and apply to the ws-side Y.Doc
    const resource = await braidText.get_resource(key);
    console.log(`[braid-text→ws] note ${noteId}: subscribing with parents=${JSON.stringify(resource.version)}`);
    const ac = new AbortController();
    braidText.get(resource, {
      range_unit: 'yjs-text',
      peer: 'ws',
      parents: resource.version,  // DT version space — skip history, live updates only
      signal: ac.signal,
      subscribe: (update: any) => {
        console.log(`[braid-text→ws] note ${noteId}: received update, patches=${update.patches?.length}, body=${update.body?.slice(0, 30)}`);
        if (update.patches) {
          try {
            console.log(`[braid-text→ws] note ${noteId}: converting ${update.patches.length} patches to yjs binary`);
            const binary = braidText.to_yjs_binary([update]);
            if (binary) {
              console.log(`[braid-text→ws] note ${noteId}: applying binary size=${binary.length} to ws Y.Doc`);
              realtimeDoc.applyUpdate(Array.from(binary), 'braid-http');
            }
          } catch (e: any) {
            this.logger.error(`braid-text→ws failed for note ${noteId}: ${e.message}`);
          }
        }
      },
    });

    // Clean up on destruction
    realtimeNote.on('destroy', () => {
      realtimeDoc.off('update', wsUpdateHandler);
      ac.abort();
    });

    return realtimeNote;
  }

  /**
   * Starts a timer that persists the realtime note in a periodic interval depending on the {@link AppConfig}.

   * @param realtimeNote The realtime note for which the timer should be started
   */
  private startPersistTimer(realtimeNote: RealtimeNote): void {
    Optional.of(this.noteConfig.persistInterval)
      .filter((value) => value > 0)
      .ifPresent((persistInterval) => {
        const intervalId = setInterval(
          this.saveRealtimeNote.bind(this, realtimeNote),
          persistInterval * 60 * 1000,
        );
        this.schedulerRegistry.addInterval(
          `periodic-persist-${realtimeNote.getNoteId()}`,
          intervalId,
        );
        realtimeNote.on('destroy', () => {
          clearInterval(intervalId);
          this.schedulerRegistry.deleteInterval(`periodic-persist-${realtimeNote.getNoteId()}`);
        });
      });
  }

  /**
   * Reflects the changes of the note's permissions to all connections of the note
   *
   * @param noteId The id of the note for that permissions changed
   */
  @OnEvent(NoteEvent.PERMISSION_CHANGE)
  public async handleNotePermissionChanged(noteId: number): Promise<void> {
    const realtimeNote = this.realtimeNoteStore.find(noteId);
    if (realtimeNote === undefined) {
      return;
    }

    realtimeNote.announcePermissionsUpdate();
    const allConnections = realtimeNote.getConnections();
    await this.updateOrCloseConnection(allConnections, noteId);
  }

  /**
   * Reflects the changes of the note's aliases to all connections of the note
   *
   * @param noteId The id of the note for that aliases changed
   * @param primaryAlias optional - The new primary alias to be used
   */
  @OnEvent(NoteEvent.ALIAS_UPDATE)
  public async handleNoteAliasesChanged(noteId: number, primaryAlias?: string): Promise<void> {
    const realtimeNote = this.realtimeNoteStore.find(noteId);
    if (realtimeNote === undefined) {
      return;
    }

    realtimeNote.announceAliasesUpdate(primaryAlias);
  }

  /**
   * Updates the connections of the given note based on the current permissions of the user.
   * If the user has no permission to edit the note, the connection is closed.
   * Otherwise, it updates the acceptEdits property of the connection.
   *
   * @param connections The connections to update
   * @param noteId The id of the note for which the connections should be updated
   */
  private async updateOrCloseConnection(
    connections: RealtimeConnection[],
    noteId: number,
  ): Promise<void> {
    for (const connection of connections) {
      const userPermissionLevel = await this.permissionService.determinePermission(
        connection.getUserId(),
        noteId,
      );
      if (userPermissionLevel === PermissionLevel.DENY) {
        connection.getTransporter().disconnect();
      } else {
        connection.acceptEdits = userPermissionLevel > PermissionLevel.READ;
      }
    }
  }

  /**
   * Reflects the deletion of a note to all connections of the note
   *
   * @param noteId The id of the just deleted note
   */
  @OnEvent(NoteEvent.DELETION)
  public handleNoteDeleted(noteId: number): void {
    const realtimeNote = this.realtimeNoteStore.find(noteId);
    if (realtimeNote) {
      realtimeNote.announceNoteDeletion();
    }
  }

  /**
   * Closes the realtime note for the given note id and saves its content
   * This is called when the note is updated externally, e.g. by the API
   *
   * @param noteId The id of the note for which the realtime note should be closed
   */
  @OnEvent(NoteEvent.CLOSE_REALTIME)
  public closeRealtimeNote(noteId: number): void {
    const realtimeNote = this.realtimeNoteStore.find(noteId);
    if (realtimeNote) {
      realtimeNote.destroy();
    }
  }
}
