import type { AlbumRepository } from '../repositories/album.repository.js';

export class AlbumService {
  constructor(private readonly albumRepository: AlbumRepository) {}

  create(ownerId: string, albumName: string) {
    return this.albumRepository.create({ ownerId, albumName }, [ownerId]);
  }

  rename(id: string, albumName: string) {
    return this.albumRepository.update(id, albumName);
  }
}
