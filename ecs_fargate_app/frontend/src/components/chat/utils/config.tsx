import { FileTokenGroupProps } from '@cloudscape-design/components/file-token-group';

export type AuthorAvatarProps = {
  type: 'user' | 'gen-ai';
  name: string;
  initials?: string;
  loading?: boolean;
};

type AuthorsType = {
  [key: string]: AuthorAvatarProps;
};

export const AUTHORS: AuthorsType = {
  'user': { type: 'user', name: 'You', initials: 'U' },
  'gen-ai': { type: 'gen-ai', name: 'Analyzer Assistant' },
};

export const fileTokenGroupI18nStrings: FileTokenGroupProps.I18nStrings = {
  removeFileAriaLabel: index => `Remove file ${index + 1}`,
  limitShowFewer: 'Show fewer files',
  limitShowMore: 'Show more files',
  errorIconAriaLabel: 'Error',
  warningIconAriaLabel: 'Warning',
};