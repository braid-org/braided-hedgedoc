/*
 * SPDX-FileCopyrightText: 2026 The HedgeDoc developers (see AUTHORS file)
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Injectable, OnModuleInit } from '@nestjs/common';

import { ConsoleLoggerService } from '../logger/console-logger.service';

@Injectable()
export class BraidService implements OnModuleInit {
  private braidText: any;

  constructor(private readonly logger: ConsoleLoggerService) {
    this.logger.setContext(BraidService.name);
  }

  async onModuleInit(): Promise<void> {
    this.braidText = await import('braid-text');
    this.braidText.cors = false;
    this.logger.log('Braid-text initialized', 'onModuleInit');
  }

  getBraidText(): any {
    return this.braidText;
  }
}
