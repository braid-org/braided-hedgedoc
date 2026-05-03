/*
 * SPDX-FileCopyrightText: 2025 The HedgeDoc developers (see AUTHORS file)
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { PermissionLevel } from '@hedgedoc/commons';
import {
  MediaUploadSchema,
  NoteMetadataSchema,
  NotePermissionsSchema,
  NoteSchema,
  RevisionMetadataSchema,
  RevisionSchema,
} from '@hedgedoc/commons';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { ApiSecurity, ApiTags } from '@nestjs/swagger';

import { BraidService } from '../../../braid/braid.service';
import { RealtimeNoteService } from '../../../realtime/realtime-note/realtime-note.service';
import { generateRateLimitKey, unlimitedEditors } from '../../../security/rate-limiting';
import { MediaUploadDto } from '../../../dtos/media-upload.dto';
import { NoteMetadataDto } from '../../../dtos/note-metadata.dto';
import { NotePermissionsDto } from '../../../dtos/note-permissions.dto';
import { NoteDto } from '../../../dtos/note.dto';
import { NoteMediaDeletionDto } from '../../../dtos/note.media-deletion.dto';
import { RevisionMetadataDto } from '../../../dtos/revision-metadata.dto';
import { RevisionDto } from '../../../dtos/revision.dto';
import { GroupsService } from '../../../groups/groups.service';
import { ConsoleLoggerService } from '../../../logger/console-logger.service';
import { MediaService } from '../../../media/media.service';
import { NoteService } from '../../../notes/note.service';
import { PermissionService } from '../../../permissions/permission.service';
import { PermissionsGuard } from '../../../permissions/permissions.guard';
import { RequirePermission } from '../../../permissions/require-permission.decorator';
import { RevisionsService } from '../../../revisions/revisions.service';
import { UsersService } from '../../../users/users.service';
import { MarkdownBody } from '../../utils/decorators/markdown-body.decorator';
import { OpenApi } from '../../utils/decorators/openapi.decorator';
import { RequestNoteId } from '../../utils/decorators/request-note-id.decorator';
import { RequestUserId } from '../../utils/decorators/request-user-id.decorator';
import { ApiTokenGuard } from '../../utils/guards/api-token.guard';
import { GetNoteIdInterceptor } from '../../utils/interceptors/get-note-id.interceptor';

@UseGuards(ApiTokenGuard, PermissionsGuard)
@OpenApi(401)
@ApiTags('notes')
@ApiSecurity('token')
@Controller('notes')
export class NotesController {
  constructor(
    private readonly logger: ConsoleLoggerService,
    private braidService: BraidService,
    private realtimeNoteService: RealtimeNoteService,
    private noteService: NoteService,
    private userService: UsersService,
    private groupService: GroupsService,
    private revisionsService: RevisionsService,
    private mediaService: MediaService,
    private permissionService: PermissionService,
  ) {
    this.logger.setContext(NotesController.name);
  }

  @RequirePermission(PermissionLevel.FULL)
  @Post()
  @OpenApi(201, 403, 409, 413)
  async createNote(
    @RequestUserId() userId: number,
    @MarkdownBody() text: string,
  ): Promise<NoteDto> {
    const newNote = await this.noteService.createNote(text, userId);
    return await this.noteService.toNoteDto(newNote);
  }

  @UseInterceptors(GetNoteIdInterceptor)
  @RequirePermission(PermissionLevel.READ)
  @Get(':noteAlias')
  @OpenApi(
    {
      code: 200,
      description: 'Get information about the newly created note',
      schema: NoteSchema,
    },
    403,
    404,
  )
  async getNote(
    @RequestUserId() _userId: number,
    @RequestNoteId() noteId: number,
  ): Promise<NoteDto> {
    return await this.noteService.toNoteDto(noteId);
  }

  @RequirePermission(PermissionLevel.FULL)
  @Post(':newNoteAlias')
  @OpenApi(
    {
      code: 201,
      description: 'Get information about the newly created note',
      schema: NoteSchema,
    },
    400,
    403,
    409,
    413,
  )
  async createNamedNote(
    @RequestUserId() userId: number,
    @Param('newNoteAlias') noteAlias: string,
    @MarkdownBody() text: string,
  ): Promise<NoteDto> {
    this.logger.debug('Got raw markdown:\n' + text, 'createNamedNote');
    const noteId = await this.noteService.createNote(text, userId, noteAlias);
    return await this.noteService.toNoteDto(noteId);
  }

  @UseInterceptors(GetNoteIdInterceptor)
  @RequirePermission(PermissionLevel.FULL)
  @Delete(':noteAlias')
  @OpenApi(204, 403, 404, 500)
  async deleteNote(
    @RequestUserId() userId: number,
    @RequestNoteId() noteId: number,
    @Body() noteMediaDeletionDto: NoteMediaDeletionDto,
  ): Promise<void> {
    const mediaUploads = await this.mediaService.getMediaUploadUuidsByNoteId(noteId);
    for (const mediaUpload of mediaUploads) {
      if (!noteMediaDeletionDto.keepMedia) {
        await this.mediaService.deleteFile(mediaUpload);
      } else {
        await this.mediaService.removeNoteFromMediaUpload(mediaUpload);
      }
    }
    this.logger.debug(`Deleting note: ${noteId}`, 'deleteNote');
    await this.noteService.deleteNote(noteId);
    this.logger.debug(`Successfully deleted ${noteId}`, 'deleteNote');
    return;
  }

  @UseInterceptors(GetNoteIdInterceptor)
  @RequirePermission(PermissionLevel.WRITE)
  @Put(':noteAlias')
  @OpenApi(
    {
      code: 200,
      description: 'The new, changed note',
      schema: NoteSchema,
    },
    403,
    404,
  )
  async updateNote(
    @RequestUserId() userId: number,
    @RequestNoteId() noteId: number,
    @MarkdownBody() text: string,
  ): Promise<NoteDto> {
    this.logger.debug('Got raw markdown: ' + text, 'updateNote');
    await this.noteService.updateNote(noteId, text);
    return await this.noteService.toNoteDto(noteId);
  }

  @UseInterceptors(GetNoteIdInterceptor)
  @RequirePermission(PermissionLevel.READ)
  @Get(':noteAlias/content')
  @OpenApi(
    {
      code: 200,
      description: 'The raw markdown content of the note',
      mimeType: 'text/markdown',
    },
    403,
    404,
  )
  async getNoteContent(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
    @RequestUserId() userId: number,
    @RequestNoteId() noteId: number,
  ): Promise<string | void> {

    // This proof-of-concept stores text *both* in HedgeDoc's existing Note
    // Service, *and* in the Braid-Text db.

    // We dispatch to Braid-Text iff the client is doing something Braidly:
    // braid protocol headers, or requesting cursor data.
    const h = req.raw.headers;
    const accept = (h['accept'] || '') as string;
    if ('version' in h || 'parents' in h
        || 'subscribe' in h || 'merge-type' in h
        || accept.includes('application/text-cursors+json')) {
      // Ensure the realtime note + braid resource exist before serving
      await this.realtimeNoteService.getOrCreateRealtimeNote(noteId);
      res.hijack();
      await this.braidService.getBraidText().serve(req.raw, res.raw, {
        key: noteId.toString(),
      });
      return;
    }

    // All other requests get the note content via HedgeDoc's normal API
    return await this.noteService.getNoteContent(noteId);
  }

  @UseInterceptors(GetNoteIdInterceptor)
  @RequirePermission(PermissionLevel.WRITE)
  @Put(':noteAlias/content')
  @OpenApi(200, 403, 404)
  async putNoteContent(
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
    @RequestNoteId() noteId: number,
  ): Promise<void> {
    const type = (req.raw.headers['repr-type'] || '') as string;

    // All PUTs currently go to Braid-Text.

    // To stay sane, let's constrain the types of mutations we allow
    {

      // First, verify client is PUTting text/plain, markdown, or cursors
      if (!(type.includes('text/plain')
            || type.includes('text/markdown')
            || type.includes('application/text-cursors+json'))) {
        res.status(415).send('Repr-Type must be text/plain, text/markdown,'
                             + ' or application/text-cursors+json');
        return;
      }

      // Second, only accept text edits from clients that know their version
      if ((!('version' in req.raw.headers) || !('parents' in req.raw.headers))
          // But cursor updates don't need version or parents.
          && !type.includes('application/text-cursors+json')) {
        res.status(400).send('Missing Version and/or Parents headers');
        return;
      }
    }

    // Since this edit is valid, remove rate-limiting for this client's future PUTs
    unlimitedEditors.add(generateRateLimitKey(req));

    // Ensure the realtime note + braid resource exist before serving
    await this.realtimeNoteService.getOrCreateRealtimeNote(noteId);
    res.hijack();
    (req.raw as any).already_buffered_body = req.body as Buffer;
    await this.braidService.getBraidText().serve(req.raw, res.raw, {
      key: noteId.toString(),
    });
  }

  @UseInterceptors(GetNoteIdInterceptor)
  @RequirePermission(PermissionLevel.READ)
  @Get(':noteAlias/metadata')
  @OpenApi(
    {
      code: 200,
      description: 'The metadata of the note',
      schema: NoteMetadataSchema,
    },
    403,
    404,
  )
  async getNoteMetadata(@RequestNoteId() noteId: number): Promise<NoteMetadataDto> {
    return await this.noteService.toNoteMetadataDto(noteId);
  }

  @UseInterceptors(GetNoteIdInterceptor)
  @RequirePermission(PermissionLevel.READ)
  @Get(':noteAlias/metadata/permissions')
  @OpenApi(
    {
      code: 200,
      description: 'Get the permissions for a note',
      schema: NotePermissionsSchema,
    },
    403,
    404,
  )
  async getPermissions(@RequestNoteId() noteId: number): Promise<NotePermissionsDto> {
    return await this.permissionService.getPermissionsDtoForNote(noteId);
  }

  @UseInterceptors(GetNoteIdInterceptor)
  @RequirePermission(PermissionLevel.FULL)
  @Put(':noteAlias/metadata/permissions/users/:userName')
  @OpenApi(
    {
      code: 200,
      description: 'Set the permissions for a user on a note',
      schema: NotePermissionsSchema,
    },
    403,
    404,
  )
  async setUserPermission(
    @RequestUserId() userId: number,
    @RequestNoteId() noteId: number,
    @Param('userName') username: string,
    @Body('canEdit') canEdit: boolean,
  ): Promise<NotePermissionsDto> {
    const targetUserId = await this.userService.getUserIdByUsername(username);
    await this.permissionService.setUserPermission(noteId, targetUserId, canEdit);
    return await this.permissionService.getPermissionsDtoForNote(noteId);
  }

  @UseInterceptors(GetNoteIdInterceptor)
  @RequirePermission(PermissionLevel.FULL)
  @Delete(':noteAlias/metadata/permissions/users/:userName')
  @OpenApi(
    {
      code: 200,
      description: 'Remove the permission for a user on a note',
      schema: NotePermissionsSchema,
    },
    403,
    404,
  )
  async removeUserPermission(
    @RequestUserId() userId: number,
    @RequestNoteId() noteId: number,
    @Param('userName') username: string,
  ): Promise<NotePermissionsDto> {
    const targetUserId = await this.userService.getUserIdByUsername(username);
    await this.permissionService.removeUserPermission(noteId, targetUserId);
    return await this.permissionService.getPermissionsDtoForNote(noteId);
  }

  @UseInterceptors(GetNoteIdInterceptor)
  @RequirePermission(PermissionLevel.FULL)
  @Put(':noteAlias/metadata/permissions/groups/:groupName')
  @OpenApi(
    {
      code: 200,
      description: 'Set the permissions for a group on a note',
      schema: NotePermissionsSchema,
    },
    403,
    404,
  )
  async setGroupPermission(
    @RequestUserId() userId: number,
    @RequestNoteId() noteId: number,
    @Param('groupName') groupName: string,
    @Body('canEdit') canEdit: boolean,
  ): Promise<NotePermissionsDto> {
    const groupId = await this.groupService.getGroupIdByName(groupName);
    await this.permissionService.setGroupPermission(noteId, groupId, canEdit);
    return await this.permissionService.getPermissionsDtoForNote(noteId);
  }

  @UseInterceptors(GetNoteIdInterceptor)
  @RequirePermission(PermissionLevel.FULL)
  @Delete(':noteAlias/metadata/permissions/groups/:groupName')
  @OpenApi(
    {
      code: 200,
      description: 'Remove the permission for a group on a note',
      schema: NotePermissionsSchema,
    },
    403,
    404,
  )
  async removeGroupPermission(
    @RequestNoteId() noteId: number,
    @Param('groupName') groupName: string,
  ): Promise<NotePermissionsDto> {
    const groupId = await this.groupService.getGroupIdByName(groupName);
    await this.permissionService.removeGroupPermission(noteId, groupId);
    return await this.permissionService.getPermissionsDtoForNote(noteId);
  }

  @UseInterceptors(GetNoteIdInterceptor)
  @RequirePermission(PermissionLevel.FULL)
  @Put(':noteAlias/metadata/permissions/owner')
  @OpenApi(
    {
      code: 200,
      description: 'Changes the owner of the note',
      schema: NoteSchema,
    },
    403,
    404,
  )
  async changeOwner(
    @RequestNoteId() noteId: number,
    @Body('newOwner') newOwner: string,
  ): Promise<NoteMetadataDto> {
    const ownerUserId = await this.userService.getUserIdByUsername(newOwner);
    await this.permissionService.changeOwner(noteId, ownerUserId);

    return await this.noteService.toNoteMetadataDto(noteId);
  }

  @UseInterceptors(GetNoteIdInterceptor)
  @RequirePermission(PermissionLevel.FULL)
  @Put(':noteAlias/metadata/permissions/visibility')
  @OpenApi(
    {
      code: 200,
      description: 'Changes the owner of the note',
      schema: NoteSchema,
    },
    403,
    404,
  )
  async change(
    @RequestNoteId() noteId: number,
    @Body('newPubliclyVisible') newPubliclyVisible: boolean,
  ): Promise<NoteMetadataDto> {
    await this.permissionService.changePubliclyVisible(noteId, newPubliclyVisible);

    return await this.noteService.toNoteMetadataDto(noteId);
  }

  @UseInterceptors(GetNoteIdInterceptor)
  @RequirePermission(PermissionLevel.READ)
  @Get(':noteAlias/revisions')
  @OpenApi(
    {
      code: 200,
      description: 'Revisions of the note',
      isArray: true,
      schema: RevisionMetadataSchema,
    },
    403,
    404,
  )
  async getNoteRevisions(@RequestNoteId() noteId: number): Promise<RevisionMetadataDto[]> {
    return await this.revisionsService.getAllRevisionMetadataDto(noteId);
  }

  @UseInterceptors(GetNoteIdInterceptor)
  @RequirePermission(PermissionLevel.READ)
  @Get(':noteAlias/revisions/:revisionUuid')
  @OpenApi(
    {
      code: 200,
      description: 'Revision of the note for the given id or aliases',
      schema: RevisionSchema,
    },
    403,
    404,
  )
  async getNoteRevision(@Param('revisionUuid') revisionUuid: string): Promise<RevisionDto> {
    return await this.revisionsService.getRevisionDto(revisionUuid);
  }

  @UseInterceptors(GetNoteIdInterceptor)
  @RequirePermission(PermissionLevel.READ)
  @Get(':noteAlias/media')
  @OpenApi({
    code: 200,
    description: 'All media uploads of the note',
    isArray: true,
    schema: MediaUploadSchema,
  })
  async getNotesMedia(@RequestNoteId() noteId: number): Promise<MediaUploadDto[]> {
    const mediaUuids = await this.mediaService.getMediaUploadUuidsByNoteId(noteId);
    return await this.mediaService.getMediaUploadDtosByUuids(mediaUuids);
  }

}
