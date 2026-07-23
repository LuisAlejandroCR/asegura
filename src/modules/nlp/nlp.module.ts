import { Module } from '@nestjs/common';
import { OllamaNlpService } from './ollama-nlp.service';

@Module({
  providers: [
    { provide: 'INlpProvider', useClass: OllamaNlpService },
    OllamaNlpService,
  ],
  exports: ['INlpProvider'],
})
export class NlpModule {}