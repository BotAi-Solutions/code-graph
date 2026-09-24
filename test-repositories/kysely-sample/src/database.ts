import type { Kysely } from 'kysely';

export interface AlbumTable {
  id: string;
  ownerId: string;
  albumName: string;
}

export interface AlbumUserTable {
  albumId: string;
  userId: string;
  role: string;
}

export interface AlbumAssetTable {
  albumId: string;
  assetId: string;
}

export interface DB {
  album: AlbumTable;
  album_user: AlbumUserTable;
  album_asset: AlbumAssetTable;
  asset: { id: string; ownerId: string };
  tag: { id: string; parentId: string | null; value: string };
  user: { id: string; name: string };
}

export type Database = Kysely<DB>;
