export type Visibility = 'public' | 'private';
export type ResponseMode = 'image' | 'redirect' | 'json';
export type Permission = 'read' | 'upload' | 'private:read' | 'random' | 'ai:classify';
export interface Grant {
  kind: 'all' | 'folder' | 'service' | 'storage';
  resourceId: string;
  descendants?: boolean;
}
export interface ApiError {
  error: { code: string; message: string; requestId: string };
}
export interface ImageInfo {
  id: string;
  name: string;
  folderId: string;
  visibility: Visibility;
  effectiveVisibility: Visibility;
  storageId: string;
  format: string;
  mime: string;
  size: number;
  width: number;
  height: number;
  tags: string[];
  description: string;
  createdAt: number;
  deletedAt: number | null;
  state: string;
  thumbnailState: string;
  processingStatus?: string;
  classificationStatus?: string;
  publicationHold?: boolean;
  hasOriginal?: boolean;
  migrating?: boolean;
  url: string;
  thumbnailUrl: string;
}
export interface StorageMigration {
  id: string;
  target_id: string | null;
  target_name: string;
  state: string;
  cleanup_state: string;
  total_count: number;
  success_count: number;
  failed_count: number;
  skipped_count: number;
  canceled_count: number;
  estimated_bytes: number;
  retained_count: number;
  retained_bytes: number;
  created_at: number;
  expires_at: number;
  error: string | null;
  selection: {
    targetStorageId: string;
    imageIds?: string[];
    sourceStorageId?: string;
    folderId?: string;
    includeChildren: boolean;
    includeTrash: boolean;
  };
  skipReasons: { reason: string; count: number }[];
}
export interface MigrationItem {
  id: string;
  image_id: string;
  name: string;
  source_name: string;
  state: string;
  phase: string;
  estimated_bytes: number;
  attempts: number;
  error: string | null;
}
