export interface DomainConfig {
  id: string;
  name: string;
  description: string;
  pillars: string[];
  questions: DomainQuestion[];
}

export interface DomainQuestion {
  id: string;
  title: string;
  pillar: string;
  bestPractices: DomainBestPractice[];
}

export interface DomainBestPractice {
  id: string;
  name: string;
  description: string;
}

export const DOMAIN_CONFIGURATIONS: Record<string, DomainConfig> = {
  saas_resilience: {
    id: 'saas_resilience',
    name: 'SaaS Resilience',
    description: 'Analyze SaaS application resilience patterns',
    pillars: ['Reliability', 'Performance', 'Security'],
    questions: [
      {
        id: 'saas_rel_001',
        title: 'How do you design for multi-tenant resilience?',
        pillar: 'Reliability',
        bestPractices: [
          {
            id: 'saas_rel_001_bp1',
            name: 'Tenant isolation',
            description: 'Implement proper tenant data and compute isolation'
          },
          {
            id: 'saas_rel_001_bp2',
            name: 'Circuit breakers',
            description: 'Use circuit breakers to prevent cascade failures'
          },
          {
            id: 'saas_rel_001_bp3',
            name: 'Failover mechanisms',
            description: 'Implement automated failover for critical services'
          }
        ]
      },
      {
        id: 'saas_perf_001',
        title: 'How do you ensure consistent performance across tenants?',
        pillar: 'Performance',
        bestPractices: [
          {
            id: 'saas_perf_001_bp1',
            name: 'Resource throttling',
            description: 'Implement per-tenant resource limits'
          },
          {
            id: 'saas_perf_001_bp2',
            name: 'Performance monitoring',
            description: 'Monitor performance metrics per tenant'
          },
          {
            id: 'saas_perf_001_bp3',
            name: 'Auto-scaling',
            description: 'Implement tenant-aware auto-scaling policies'
          }
        ]
      },
      {
        id: 'saas_sec_001',
        title: 'How do you secure multi-tenant data?',
        pillar: 'Security',
        bestPractices: [
          {
            id: 'saas_sec_001_bp1',
            name: 'Data encryption',
            description: 'Encrypt data at rest and in transit per tenant'
          },
          {
            id: 'saas_sec_001_bp2',
            name: 'Access controls',
            description: 'Implement tenant-specific access controls'
          },
          {
            id: 'saas_sec_001_bp3',
            name: 'Audit logging',
            description: 'Maintain comprehensive audit logs per tenant'
          }
        ]
      }
    ]
  },
  eks_resilience: {
    id: 'eks_resilience',
    name: 'EKS Resilience',
    description: 'Analyze Kubernetes cluster resilience on EKS',
    pillars: ['Reliability', 'Security', 'Performance'],
    questions: [
      {
        id: 'eks_rel_001',
        title: 'How do you ensure cluster availability?',
        pillar: 'Reliability',
        bestPractices: [
          {
            id: 'eks_rel_001_bp1',
            name: 'Multi-AZ deployment',
            description: 'Deploy across multiple availability zones'
          },
          {
            id: 'eks_rel_001_bp2',
            name: 'Node group diversity',
            description: 'Use multiple node groups with different instance types'
          },
          {
            id: 'eks_rel_001_bp3',
            name: 'Pod disruption budgets',
            description: 'Configure pod disruption budgets for critical workloads'
          }
        ]
      },
      {
        id: 'eks_sec_001',
        title: 'How do you secure your EKS cluster?',
        pillar: 'Security',
        bestPractices: [
          {
            id: 'eks_sec_001_bp1',
            name: 'RBAC implementation',
            description: 'Implement role-based access control'
          },
          {
            id: 'eks_sec_001_bp2',
            name: 'Network policies',
            description: 'Use Kubernetes network policies for pod-to-pod communication'
          },
          {
            id: 'eks_sec_001_bp3',
            name: 'Secrets management',
            description: 'Use AWS Secrets Manager or Kubernetes secrets'
          }
        ]
      },
      {
        id: 'eks_perf_001',
        title: 'How do you optimize EKS performance?',
        pillar: 'Performance',
        bestPractices: [
          {
            id: 'eks_perf_001_bp1',
            name: 'Resource requests and limits',
            description: 'Set appropriate CPU and memory requests/limits'
          },
          {
            id: 'eks_perf_001_bp2',
            name: 'Horizontal Pod Autoscaler',
            description: 'Configure HPA for automatic scaling'
          },
          {
            id: 'eks_perf_001_bp3',
            name: 'Cluster autoscaler',
            description: 'Enable cluster autoscaler for node scaling'
          }
        ]
      }
    ]
  },
  serverless_resilience: {
    id: 'serverless_resilience',
    name: 'Serverless Resilience',
    description: 'Analyze serverless application resilience patterns',
    pillars: ['Reliability', 'Performance', 'Cost'],
    questions: [
      {
        id: 'sls_rel_001',
        title: 'How do you handle Lambda function failures?',
        pillar: 'Reliability',
        bestPractices: [
          {
            id: 'sls_rel_001_bp1',
            name: 'Dead letter queues',
            description: 'Implement DLQ for failed function invocations'
          },
          {
            id: 'sls_rel_001_bp2',
            name: 'Retry mechanisms',
            description: 'Configure appropriate retry policies'
          },
          {
            id: 'sls_rel_001_bp3',
            name: 'Circuit breakers',
            description: 'Implement circuit breaker patterns for external calls'
          }
        ]
      },
      {
        id: 'sls_perf_001',
        title: 'How do you optimize serverless performance?',
        pillar: 'Performance',
        bestPractices: [
          {
            id: 'sls_perf_001_bp1',
            name: 'Memory optimization',
            description: 'Right-size Lambda function memory allocation'
          },
          {
            id: 'sls_perf_001_bp2',
            name: 'Cold start mitigation',
            description: 'Implement strategies to reduce cold start impact'
          },
          {
            id: 'sls_perf_001_bp3',
            name: 'Connection pooling',
            description: 'Use connection pooling for database connections'
          }
        ]
      },
      {
        id: 'sls_cost_001',
        title: 'How do you optimize serverless costs?',
        pillar: 'Cost',
        bestPractices: [
          {
            id: 'sls_cost_001_bp1',
            name: 'Function timeout optimization',
            description: 'Set appropriate timeout values for functions'
          },
          {
            id: 'sls_cost_001_bp2',
            name: 'Reserved concurrency',
            description: 'Use reserved concurrency to control costs'
          },
          {
            id: 'sls_cost_001_bp3',
            name: 'Cost monitoring',
            description: 'Monitor and alert on serverless costs'
          }
        ]
      }
    ]
  },
  data_resilience: {
    id: 'data_resilience',
    name: 'Data Resilience',
    description: 'Analyze data layer resilience and backup strategies',
    pillars: ['Reliability', 'Security', 'Cost'],
    questions: [
      {
        id: 'data_rel_001',
        title: 'How do you ensure data durability?',
        pillar: 'Reliability',
        bestPractices: [
          {
            id: 'data_rel_001_bp1',
            name: 'Cross-region replication',
            description: 'Implement cross-region data replication'
          },
          {
            id: 'data_rel_001_bp2',
            name: 'Automated backups',
            description: 'Set up automated backup schedules'
          },
          {
            id: 'data_rel_001_bp3',
            name: 'Point-in-time recovery',
            description: 'Enable point-in-time recovery capabilities'
          }
        ]
      },
      {
        id: 'data_sec_001',
        title: 'How do you secure your data?',
        pillar: 'Security',
        bestPractices: [
          {
            id: 'data_sec_001_bp1',
            name: 'Encryption at rest',
            description: 'Encrypt all data at rest using strong encryption'
          },
          {
            id: 'data_sec_001_bp2',
            name: 'Encryption in transit',
            description: 'Encrypt data in transit between services'
          },
          {
            id: 'data_sec_001_bp3',
            name: 'Access logging',
            description: 'Log all data access and modifications'
          }
        ]
      },
      {
        id: 'data_cost_001',
        title: 'How do you optimize data storage costs?',
        pillar: 'Cost',
        bestPractices: [
          {
            id: 'data_cost_001_bp1',
            name: 'Storage tiering',
            description: 'Implement intelligent storage tiering'
          },
          {
            id: 'data_cost_001_bp2',
            name: 'Data lifecycle policies',
            description: 'Set up automated data lifecycle management'
          },
          {
            id: 'data_cost_001_bp3',
            name: 'Compression',
            description: 'Use data compression to reduce storage costs'
          }
        ]
      }
    ]
  },
  network_resilience: {
    id: 'network_resilience',
    name: 'Network Resilience',
    description: 'Analyze network architecture resilience patterns',
    pillars: ['Reliability', 'Security', 'Performance'],
    questions: [
      {
        id: 'net_rel_001',
        title: 'How do you design resilient network architecture?',
        pillar: 'Reliability',
        bestPractices: [
          {
            id: 'net_rel_001_bp1',
            name: 'Multi-AZ subnets',
            description: 'Deploy subnets across multiple availability zones'
          },
          {
            id: 'net_rel_001_bp2',
            name: 'Redundant connectivity',
            description: 'Implement redundant network paths'
          },
          {
            id: 'net_rel_001_bp3',
            name: 'Load balancing',
            description: 'Use load balancers for traffic distribution'
          }
        ]
      },
      {
        id: 'net_sec_001',
        title: 'How do you secure your network?',
        pillar: 'Security',
        bestPractices: [
          {
            id: 'net_sec_001_bp1',
            name: 'Network segmentation',
            description: 'Implement proper network segmentation'
          },
          {
            id: 'net_sec_001_bp2',
            name: 'Security groups',
            description: 'Configure restrictive security group rules'
          },
          {
            id: 'net_sec_001_bp3',
            name: 'VPC Flow Logs',
            description: 'Enable VPC Flow Logs for monitoring'
          }
        ]
      },
      {
        id: 'net_perf_001',
        title: 'How do you optimize network performance?',
        pillar: 'Performance',
        bestPractices: [
          {
            id: 'net_perf_001_bp1',
            name: 'Enhanced networking',
            description: 'Enable enhanced networking features'
          },
          {
            id: 'net_perf_001_bp2',
            name: 'Placement groups',
            description: 'Use placement groups for low latency'
          },
          {
            id: 'net_perf_001_bp3',
            name: 'CDN integration',
            description: 'Integrate with CloudFront for content delivery'
          }
        ]
      }
    ]
  }
};

export function getDomainConfig(domainId: string): DomainConfig | undefined {
  return DOMAIN_CONFIGURATIONS[domainId];
}

export function getAllDomains(): DomainConfig[] {
  return Object.values(DOMAIN_CONFIGURATIONS);
}