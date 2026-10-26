import { createSync } from 'nango';
import * as z from 'zod';

const FinnorPublicRepository = z.object({
  id: z.string(),
  fullName: z.string(),
  url: z.string(),
  description: z.string(),
});

const GitHubRepository = z.object({
  id: z.number().int().positive(),
  full_name: z.string().min(1),
  html_url: z.string().url(),
  description: z.string().nullable(),
});

export default createSync({
  description: 'Read-only public GitHub repository metadata for FINNOR source qualification.',
  version: '1.0.0',
  frequency: 'every week',
  autoStart: false,
  models: { FinnorPublicRepository },
  exec: async nango => {
    const response = await nango.get({
      endpoint: '/repos/NangoHQ/nango',
      baseUrlOverride: 'https://api.github.com',
      retries: 1,
    });
    const repository = GitHubRepository.parse(response.data);
    await nango.batchSave([{
      id: String(repository.id),
      fullName: repository.full_name,
      url: repository.html_url,
      description: repository.description ?? '',
    }], 'FinnorPublicRepository');
  },
});
