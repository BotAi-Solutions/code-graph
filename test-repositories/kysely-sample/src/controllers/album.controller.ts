import type { AlbumService } from '../services/album.service.js';

export class AlbumController {
  constructor(private readonly service: AlbumService) {}

  createAlbum(body: { ownerId: string; albumName: string }) {
    return this.service.create(body.ownerId, body.albumName);
  }
}
