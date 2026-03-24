/*
 * SPDX-FileCopyrightText: 2026 The HedgeDoc developers (see AUTHORS file)
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('revision', (table) => {
    table.text('braid_version').nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('revision', (table) => {
    table.dropColumn('braid_version');
  });
};
