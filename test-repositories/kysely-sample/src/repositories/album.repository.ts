import { sql, type Kysely } from 'kysely';
import type { DB } from '../database.js';

export class AlbumRepository {
  constructor(private readonly db: Kysely<DB>) {}

  getById(id: string) {
    return this.db
      .selectFrom('album')
      .innerJoin('album_user', 'album_user.albumId', 'album.id')
      .selectAll('album')
      .where('album.id', '=', id)
      .executeTakeFirst();
  }

  async create(album: { ownerId: string; albumName: string }, userIds: string[]) {
    return this.db
      .with('album', (db) => db.insertInto('album').values(album).returningAll())
      .with('album_user', (db) =>
        db
          .insertInto('album_user')
          .expression((eb) =>
            eb
              .selectFrom('album')
              .select((eb) => ['album.id', eb.val(userIds[0] ?? '').as('userId'), eb.val('owner').as('role')]),
          ),
      )
      .selectFrom('album')
      .selectAll()
      .executeTakeFirstOrThrow();
  }

  update(id: string, albumName: string) {
    return this.db.updateTable('album').set({ albumName }).where('id', '=', id).execute();
  }

  delete(id: string) {
    return this.db.deleteFrom('album').where('id', '=', id).execute();
  }

  countAssets(userId: string) {
    return this.db
      .selectFrom('album as a')
      .leftJoin('album_asset', 'album_asset.albumId', 'a.id')
      .where((eb) =>
        eb.exists(eb.selectFrom('album_user').whereRef('album_user.albumId', '=', 'a.id').where('album_user.userId', '=', userId)),
      )
      .select((eb) => eb.fn.count('album_asset.assetId').as('count'))
      .executeTakeFirst();
  }

  touchTwice(id: string) {
    const first = this.db.selectFrom('album').select('id').where('id', '=', id);
    const second = this.db.selectFrom('album').select('albumName').where('id', '=', id);
    return Promise.all([first.execute(), second.execute()]);
  }

  countRaw() {
    return sql`SELECT count(*) FROM album`.execute(this.db);
  }

  countIn(table: 'album' | 'asset') {
    return this.db.selectFrom(table).select((eb) => eb.fn.countAll().as('count')).executeTakeFirst();
  }

  moveAssets(from: string, to: string) {
    return this.db
      .with('moved', (db) =>
        db.deleteFrom('album_asset').where('albumId', '=', from).returning('assetId'),
      )
      .with('owner', (db) => db.selectFrom('album').select('ownerId').where('id', '=', to))
      .insertInto('album_asset')
      .expression((eb) => eb.selectFrom('moved').innerJoin('owner', (join) => join.onTrue()).select(['moved.assetId']))
      .execute();
  }
}
