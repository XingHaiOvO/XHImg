export type Visibility = 'public' | 'private';
export type ResponseMode = 'image' | 'redirect' | 'json';
export type Permission = 'read' | 'upload' | 'private:read' | 'random';
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
  url: string;
  thumbnailUrl: string;
}
