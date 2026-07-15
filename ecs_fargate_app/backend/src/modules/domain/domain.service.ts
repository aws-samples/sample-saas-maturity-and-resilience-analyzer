import { Injectable } from '@nestjs/common';
import { getAllDomains, getDomainConfig } from '../../config/domain.config';

@Injectable()
export class DomainService {
  getAllDomains() {
    return getAllDomains();
  }

  getDomainConfig(domainId: string) {
    return getDomainConfig(domainId);
  }
}