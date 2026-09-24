import type { Kysely } from 'kysely';
import type { DB } from '../database.js';

export class TagRepository {
  constructor(private readonly db: Kysely<DB>) {}

  descendants(tagId: string) {
    return this.db
      .withRecursive('descendants', (db) =>
        db
          .selectFrom('tag')
          .select(['id', 'parentId'])
          .where('id', '=', tagId)
          .unionAll((eb) =>
            eb.selectFrom('tag').innerJoin('descendants', 'descendants.id', 'tag.parentId').select(['tag.id', 'tag.parentId']),
          ),
      )
      .selectFrom('descendants')
      .selectAll()
      .execute();
  }

  upsertWithCarriedCte(value: string) {
    let query = this.db.with('existing', (db) => db.selectFrom('tag').select('id').where('value', '=', value));
    query = query.with('user', (db) => db.selectFrom('existing').select('id'));
    return query.selectFrom('user').selectAll().execute();
  }
}
