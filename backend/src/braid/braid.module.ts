/*
 * SPDX-FileCopyrightText: 2026 The HedgeDoc developers (see AUTHORS file)
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Module } from '@nestjs/common';

import { LoggerModule } from '../logger/logger.module';
import { RevisionsModule } from '../revisions/revisions.module';
import { BraidService } from './braid.service';

@Module({
  imports: [LoggerModule, RevisionsModule],
  providers: [BraidService],
  exports: [BraidService],
})
export class BraidModule {}
