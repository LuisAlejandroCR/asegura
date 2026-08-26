// leads.module.ts: expone LeadService, la lista de personas a las que hay que devolver la
// llamada. Módulo propio y no parte de ChannelModule porque un lead no es un canal: lo escribe
// quien cierra una conversación y lo lee, más adelante, quien la retoma.
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { LeadService } from './lead.service';

@Module({
  imports: [DatabaseModule],
  providers: [LeadService],
  exports: [LeadService],
})
export class LeadsModule {}
