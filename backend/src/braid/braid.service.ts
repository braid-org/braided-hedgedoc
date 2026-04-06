/*
 * SPDX-FileCopyrightText: 2026 The HedgeDoc developers (see AUTHORS file)
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { BeforeApplicationShutdown, Injectable, OnModuleInit } from '@nestjs/common';

import { ConsoleLoggerService } from '../logger/console-logger.service';
import { RevisionsService } from '../revisions/revisions.service';

@Injectable()
export class BraidService implements OnModuleInit, BeforeApplicationShutdown {
  private braidText: any;

  constructor(
    private readonly logger: ConsoleLoggerService,
    private readonly revisionsService: RevisionsService,
  ) {
    this.logger.setContext(BraidService.name);
  }

  async onModuleInit(): Promise<void> {
    this.braidText = (await import('braid-text')).default;
    this.braidText.cors = false;
    this.braidText.debug_sync_checks = true;
    this.logger.log('Braid-text initialized', 'onModuleInit');
  }

  beforeApplicationShutdown(): void {
    this.braidText?.end_all_subscriptions?.();
  }

  getBraidText(): any {
    return this.braidText;
  }

  /**
   * Initialize the braid-text resource for a note, using the latest revision
   * from the database. Call this before serving any braid-HTTP request or
   * setting up realtime sync.
   */
  async initBraidResource(noteId: number): Promise<void> {
    const key = noteId.toString();
    const braidText = this.braidText;

    await braidText.get_resource(key, {
      initializer: async () => {
        const lastRevision = await this.revisionsService.getLatestRevision(noteId);
        const yjsState = lastRevision.yjs_state_vector?.buffer;
        console.log(`[initBraidResource] note ${noteId}: from DB: content="${lastRevision.content?.slice(0, 50)}" (${lastRevision.content?.length} chars), yjs_state=${yjsState ? `${new Uint8Array(yjsState).length} bytes` : 'null'}`);
        return {
          dt: true,
          yjs: {
            channel: 'markdownContent',
            history: yjsState ? new Uint8Array(yjsState) : undefined,
          },
        };

      },
    });
    this.logger.log(`Initialized braid resource for note ${noteId}`);
  }
}
