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

  onModuleInit(): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    this.braidText = require('braid-text');
    this.braidText.cors = false;
    // Use braid-text's default file storage (./braid-text-db)
    this.logger.log('Braid-text initialized', 'onModuleInit');
  }

  getBraidText(): any {
    return this.braidText;
  }
}
