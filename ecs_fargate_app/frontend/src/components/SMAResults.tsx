import React, { useState, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  Container,
  Header,
  SpaceBetween,
  KeyValuePairs,
  StatusIndicator,
  Badge,
  Table,
  Box,
  ExpandableSection,
  ColumnLayout,
  Button,
  Popover,
  Alert,
} from '@cloudscape-design/components';
import {
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  Radar,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';
import { AnalysisResult, IaCTemplateType } from '../types';
import { DetailsModal } from './DetailsModal';
import { analyzerApi } from '../services/api';
import { useChat } from '../components/chat/ChatContext';

// ─── Types ───────────────────────────────────────────────────────────────────

interface SMAResultsProps {
  results: AnalysisResult[];
  isAnalyzing: boolean;
  onDownloadRecommendations: () => void;
  onGenerateSMAReport: () => void;
  isDownloading: boolean;
  isGeneratingReport: boolean;
  isLoadingDetails: boolean;
  setIsLoadingDetails: (loading: boolean) => void;
  selectedIaCType: IaCTemplateType;
  setError: (error: string | null) => void;
  fileId: string;
  fileName: string;
  domain?: string;
  outputLanguage: string;
}

interface PillarSummary {
  pillar: string;
  avgMaturity: number;
  questionCount: number;
  highConfidence: number;
  processNotes: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MATURITY_COLORS = {
  low: '#d91515',      // red — levels 1-2
  mid: '#0972d3',      // blue — level 3
  high: '#037f0c',     // green — levels 4-5
} as const;

const getMaturityColor = (level: number | null | undefined): string => {
  if (!level || level <= 2) return MATURITY_COLORS.low;
  if (level === 3) return MATURITY_COLORS.mid;
  return MATURITY_COLORS.high;
};

const getMaturityBadgeColor = (level: number | null | undefined): 'red' | 'blue' | 'green' | 'grey' => {
  if (!level) return 'grey';
  if (level <= 2) return 'red';
  if (level === 3) return 'blue';
  return 'green';
};

const getConfidenceBadgeColor = (confidence?: string): 'green' | 'blue' | 'grey' => {
  if (confidence === 'high') return 'green';
  if (confidence === 'medium') return 'blue';
  return 'grey';
};

// ─── Maturity Rubric Data ─────────────────────────────────────────────────

const MATURITY_RUBRIC = [
  { level: 1, name: 'Manual / Ad-hoc', description: 'No automation, manual processes, high risk', color: MATURITY_COLORS.low },
  { level: 2, name: 'Documented / Repeatable', description: 'Documented procedures, still largely manual', color: MATURITY_COLORS.low },
  { level: 3, name: 'Partially Automated', description: 'Largely automated with some manual intervention', color: MATURITY_COLORS.mid },
  { level: 4, name: 'Mostly Automated', description: 'Fully automated with minimal manual exceptions', color: MATURITY_COLORS.high },
  { level: 5, name: 'Optimized / Continuous', description: 'Fully automated with continuous optimization, analytics-driven', color: MATURITY_COLORS.high },
] as const;



// ─── Maturity Dots Indicator ─────────────────────────────────────────────────

const MaturityDots: React.FC<{ level: number | null | undefined }> = ({ level }) => {
  const safeLevel = level ?? 0;
  const color = getMaturityColor(level);
  const rubricEntry = MATURITY_RUBRIC.find(r => r.level === safeLevel);
  const tooltipContent = (
    <SpaceBetween size="xxs">
      {MATURITY_RUBRIC.map(r => (
        <div key={r.level} style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: r.level === safeLevel ? 1 : 0.5 }}>
          <span style={{
            display: 'inline-block',
            width: 10,
            height: 10,
            borderRadius: '50%',
            backgroundColor: r.color,
            flexShrink: 0,
          }} />
          <span style={{ fontWeight: r.level === safeLevel ? 700 : 400, fontSize: 13 }}>
            {r.level}. {r.name}
          </span>
        </div>
      ))}
    </SpaceBetween>
  );

  return (
    <Popover
      header={rubricEntry ? `${rubricEntry.name}` : `Level ${safeLevel}`}
      content={tooltipContent}
      triggerType="custom"
      size="medium"
    >
      <SpaceBetween direction="horizontal" size="xxxs" alignItems="center">
        <span style={{ display: 'inline-flex', gap: '3px', alignItems: 'center', cursor: 'pointer' }}>
          {[1, 2, 3, 4, 5].map(i => (
            <span
              key={i}
              style={{
                display: 'inline-block',
                width: 12,
                height: 12,
                borderRadius: '50%',
                backgroundColor: i <= safeLevel ? color : '#d5dbdb',
                border: `1px solid ${i <= safeLevel ? color : '#b6bec9'}`,
              }}
              aria-hidden="true"
            />
          ))}
        </span>
        <Badge color={getMaturityBadgeColor(level)}>{safeLevel}/5</Badge>
      </SpaceBetween>
    </Popover>
  );
};

// ─── Custom Radar Tooltip ────────────────────────────────────────────────────

const RadarTooltipContent: React.FC<{ active?: boolean; payload?: Array<{ value: number; payload: { pillar: string } }> }> = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const data = payload[0];
  return (
    <div style={{
      background: '#fff',
      border: '1px solid #d5dbdb',
      borderRadius: 8,
      padding: '8px 12px',
      boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
    }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{data.payload.pillar}</div>
      <div>Avg Maturity: <strong>{data.value.toFixed(1)}</strong> / 5</div>
    </div>
  );
};

// ─── Main Component ──────────────────────────────────────────────────────────

export const SMAResults: React.FC<SMAResultsProps> = ({
  results,
  isAnalyzing,
  onDownloadRecommendations,
  onGenerateSMAReport,
  isDownloading,
  isGeneratingReport,
  isLoadingDetails,
  setIsLoadingDetails,
  selectedIaCType,
  setError,
  fileId,
  fileName,
  domain,
  outputLanguage,
}) => {
  const [selectedQuestion, setSelectedQuestion] = useState<AnalysisResult | null>(null);
  const [detailsModalVisible, setDetailsModalVisible] = useState(false);
  const [detailsContent, setDetailsContent] = useState('');
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const { openChatWithSupportPrompt } = useChat();

  // ─── Computed Data ───────────────────────────────────────────────────────

  const pillarSummaries = useMemo<PillarSummary[]>(() => {
    const pillarMap = new Map<string, AnalysisResult[]>();
    results.forEach(r => {
      const list = pillarMap.get(r.pillar) || [];
      list.push(r);
      pillarMap.set(r.pillar, list);
    });

    return Array.from(pillarMap.entries()).map(([pillar, questions]) => {
      const maturityValues = questions
        .map(q => q.maturityLevel)
        .filter((v): v is number => v != null);
      const avg = maturityValues.length > 0
        ? maturityValues.reduce((a, b) => a + b, 0) / maturityValues.length
        : 0;
      return {
        pillar,
        avgMaturity: Math.round(avg * 10) / 10,
        questionCount: questions.length,
        highConfidence: questions.filter(q => q.confidence === 'high').length,
        processNotes: questions.filter(q => q.processAssessmentNote).length,
      };
    });
  }, [results]);

  const overallMaturity = useMemo(() => {
    const values = results.map(r => r.maturityLevel).filter((v): v is number => v != null);
    if (values.length === 0) return 0;
    return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
  }, [results]);

  const radarData = useMemo(() =>
    pillarSummaries.map(p => ({
      pillar: p.pillar.length > 25 ? p.pillar.substring(0, 22) + '...' : p.pillar,
      fullPillar: p.pillar,
      maturity: p.avgMaturity,
    })),
    [pillarSummaries]
  );

  const totalHighConfidence = results.filter(r => r.confidence === 'high').length;
  const totalProcessNotes = results.filter(r => r.processAssessmentNote).length;

  // ─── Grouped by pillar ───────────────────────────────────────────────────

  const questionsByPillar = useMemo(() => {
    const map = new Map<string, AnalysisResult[]>();
    results.forEach(r => {
      const list = map.get(r.pillar) || [];
      list.push(r);
      map.set(r.pillar, list);
    });
    return map;
  }, [results]);

  // ─── Handlers ──────────────────────────────────────────────────────────

  const handleGetMoreDetails = async () => {
    if (!selectedQuestion) return;
    try {
      setIsLoadingDetails(true);
      setDetailsError(null);

      const selectedItems = [{
        pillar: selectedQuestion.pillar,
        question: selectedQuestion.question,
        questionId: selectedQuestion.questionId,
        bestPractices: selectedQuestion.bestPractices,
      }];

      const result = await analyzerApi.getMoreDetails(
        selectedItems,
        fileId,
        selectedIaCType,
        domain,
        outputLanguage
      );

      if (result.error) setDetailsError(result.error);
      if (result.content) {
        setDetailsContent(result.content);
        setDetailsModalVisible(true);
      } else {
        setError('No content received from analysis. Please try again.');
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to get detailed analysis');
    } finally {
      setIsLoadingDetails(false);
    }
  };

  const handleAiChatClick = (result: AnalysisResult) => {
    const prompt = `Can you provide more detailed recommendations for the SaaS Maturity Assessment question '${result.category}' in the '${result.pillar}' pillar? Current maturity level is ${result.maturityLevel}/5.`;
    openChatWithSupportPrompt(prompt);
  };

  // ─── Render ────────────────────────────────────────────────────────────

  return (
    <SpaceBetween size="l">
      {/* ── Section 1: Summary KPIs ── */}
      <Container variant="stacked">
        <KeyValuePairs
          columns={4}
          items={[
            {
              label: 'Overall Maturity',
              value: isAnalyzing
                ? <StatusIndicator type="loading">Analyzing...</StatusIndicator>
                : <SpaceBetween direction="horizontal" size="xs" alignItems="center">
                    <Badge color={getMaturityBadgeColor(Math.round(overallMaturity))}>{overallMaturity.toFixed(1)} / 5</Badge>
                  </SpaceBetween>,
            },
            {
              label: 'Questions Assessed',
              value: isAnalyzing
                ? <StatusIndicator type="loading">Loading</StatusIndicator>
                : <StatusIndicator type="info">{results.length}</StatusIndicator>,
            },
            {
              label: 'High Confidence',
              value: isAnalyzing
                ? <StatusIndicator type="loading">Loading</StatusIndicator>
                : <StatusIndicator type="success">{totalHighConfidence}</StatusIndicator>,
            },
            {
              label: 'Process Assessment Notes',
              value: isAnalyzing
                ? <StatusIndicator type="loading">Loading</StatusIndicator>
                : <StatusIndicator type="warning">{totalProcessNotes}</StatusIndicator>,
            },
          ]}
        />
      </Container>

      {/* ── Maturity Level Guide (collapsible) ── */}
      <ExpandableSection headerText="Understanding Maturity Levels" variant="footer">
        <Table
          variant="embedded"
          columnDefinitions={[
            {
              id: 'indicator',
              header: 'Level',
              cell: item => (
                <SpaceBetween direction="horizontal" size="xs" alignItems="center">
                  <span style={{
                    display: 'inline-block',
                    width: 12,
                    height: 12,
                    borderRadius: '50%',
                    backgroundColor: item.color,
                  }} />
                  <span style={{ fontWeight: 600 }}>{item.level}</span>
                </SpaceBetween>
              ),
              width: 80,
            },
            {
              id: 'name',
              header: 'Maturity Stage',
              cell: item => <Box fontWeight="bold">{item.name}</Box>,
              width: 200,
            },
            {
              id: 'description',
              header: 'Description',
              cell: item => item.description,
            },
          ]}
          items={MATURITY_RUBRIC as unknown as typeof MATURITY_RUBRIC[number][]}
          sortingDisabled
        />
      </ExpandableSection>

      {/* ── Section 2: Radar Chart + Pillar Table ── */}
      <Container
        header={
          <Header
            variant="h3"
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                <Button
                  onClick={handleGetMoreDetails}
                  loading={isLoadingDetails}
                  disabled={!selectedQuestion || isLoadingDetails}
                  iconName="gen-ai"
                >
                  Get More Details
                </Button>
                <Button
                  onClick={onGenerateSMAReport}
                  loading={isGeneratingReport}
                  disabled={isGeneratingReport || isAnalyzing}
                  iconName="file"
                >
                  Generate Report
                </Button>
                <Button
                  onClick={onDownloadRecommendations}
                  loading={isDownloading}
                  disabled={isDownloading}
                  iconName="download"
                >
                  Download CSV
                </Button>
              </SpaceBetween>
            }
          >
            SaaS Maturity Assessment Results
          </Header>
        }
      >
        <ColumnLayout columns={2} variant="text-grid">
          {/* Radar Chart */}
          <div>
            <Box variant="h4" padding={{ bottom: 's' }}>Pillar Maturity Overview</Box>
            <ResponsiveContainer width="100%" height={320}>
              <RadarChart data={radarData} cx="50%" cy="50%" outerRadius="75%">
                <PolarGrid stroke="#d5dbdb" />
                <PolarAngleAxis
                  dataKey="pillar"
                  tick={{ fontSize: 11, fill: '#545b64' }}
                />
                <PolarRadiusAxis
                  domain={[0, 5]}
                  tickCount={6}
                  tick={{ fontSize: 10, fill: '#879596' }}
                  axisLine={false}
                />
                <Radar
                  dataKey="maturity"
                  stroke="#0972d3"
                  fill="#0972d3"
                  fillOpacity={0.25}
                  strokeWidth={2}
                  dot={{ r: 4, fill: '#0972d3' }}
                />
                <Tooltip content={<RadarTooltipContent />} />
              </RadarChart>
            </ResponsiveContainer>
          </div>

          {/* Pillar Summary Table */}
          <div>
            <Box variant="h4" padding={{ bottom: 's' }}>Pillar Breakdown</Box>
            <Table
              variant="embedded"
              columnDefinitions={[
                {
                  id: 'pillar',
                  header: 'Pillar',
                  cell: item => item.pillar,
                  sortingField: 'pillar',
                },
                {
                  id: 'avgMaturity',
                  header: 'Average Maturity',
                  cell: item => (
                    <Badge color={getMaturityBadgeColor(Math.round(item.avgMaturity))}>
                      {item.avgMaturity.toFixed(1)} / 5
                    </Badge>
                  ),
                  sortingField: 'avgMaturity',
                },
                {
                  id: 'questions',
                  header: 'Questions Assessed',
                  cell: item => item.questionCount,
                },
                {
                  id: 'confidence',
                  header: 'High Confidence',
                  cell: item => item.highConfidence,
                },
              ]}
              items={pillarSummaries}
              sortingDisabled
              wrapLines
            />
          </div>
        </ColumnLayout>
      </Container>

      {/* ── Section 3: Per-Pillar Question Details ── */}
      {Array.from(questionsByPillar.entries()).map(([pillar, questions]) => {
        const pillarSummary = pillarSummaries.find(p => p.pillar === pillar);
        return (
          <ExpandableSection
            key={pillar}
            defaultExpanded
            variant="container"
            headerText={
              `${pillar}  —  Avg: ${pillarSummary?.avgMaturity.toFixed(1) ?? '?'}/5  (${questions.length} questions)`
            }
          >
            <Table
              variant="embedded"
              columnDefinitions={[
                {
                  id: 'category',
                  header: 'Category',
                  cell: item => <Box fontWeight="bold">{item.category || '—'}</Box>,
                  sortingField: 'category',
                  width: 180,
                },
                {
                  id: 'question',
                  header: 'Question',
                  cell: item => (
                    <Popover
                      header={item.category || item.questionId}
                      content={item.question}
                      triggerType="text"
                      size="large"
                    >
                      <Box color="text-status-info" fontSize="body-s">
                        {item.question.length > 80 ? item.question.substring(0, 77) + '...' : item.question}
                      </Box>
                    </Popover>
                  ),
                  width: 280,
                },
                {
                  id: 'maturity',
                  header: 'Maturity Level',
                  cell: item => <MaturityDots level={item.maturityLevel} />,
                  sortingField: 'maturityLevel',
                  width: 200,
                },
                {
                  id: 'confidence',
                  header: 'Confidence',
                  cell: item => (
                    <Badge color={getConfidenceBadgeColor(item.confidence)}>
                      {item.confidence || 'N/A'}
                    </Badge>
                  ),
                  width: 110,
                },
                {
                  id: 'processNote',
                  header: 'Process Note',
                  cell: item => item.processAssessmentNote
                    ? <Popover
                        header="Process Assessment Note"
                        content={<ReactMarkdown>{item.processAssessmentNote}</ReactMarkdown>}
                        triggerType="text"
                        size="large"
                      >
                        <StatusIndicator type="warning">Yes</StatusIndicator>
                      </Popover>
                    : <StatusIndicator type="stopped">No</StatusIndicator>,
                  width: 120,
                },
                {
                  id: 'actions',
                  header: 'Actions',
                  cell: item => (
                    <SpaceBetween direction="horizontal" size="xs">
                      <Button
                        iconName="gen-ai"
                        variant="inline-icon"
                        onClick={() => handleAiChatClick(item)}
                        ariaLabel="Ask AI for more recommendations"
                      />
                    </SpaceBetween>
                  ),
                  width: 70,
                },
              ]}
              items={questions}
              sortingDisabled
              wrapLines
              selectionType="single"
              selectedItems={selectedQuestion && questions.some(q => q.questionId === selectedQuestion.questionId) ? [selectedQuestion] : []}
              onSelectionChange={({ detail }) => {
                setSelectedQuestion(detail.selectedItems[0] || null);
              }}
              trackBy="questionId"
            />

            {/* Detail panel for selected question within this pillar */}
            {selectedQuestion && questions.some(q => q.questionId === selectedQuestion.questionId) && (
              <Box padding={{ top: 'm' }}>
                <ExpandableSection
                  defaultExpanded
                  headerText={`Details: ${selectedQuestion.category || selectedQuestion.questionId}`}
                >
                  <SpaceBetween size="m">
                    {/* Maturity Justification */}
                    {selectedQuestion.maturityJustification && (
                      <div>
                        <Box variant="h5">Maturity Justification</Box>
                        <Box variant="p" color="text-body-secondary">
                          <ReactMarkdown>{selectedQuestion.maturityJustification}</ReactMarkdown>
                        </Box>
                      </div>
                    )}

                    {/* IaC Evidence */}
                    {selectedQuestion.iacEvidence && (
                      <div>
                        <Box variant="h5">IaC Evidence</Box>
                        <Box padding="s">
                          <ReactMarkdown>{selectedQuestion.iacEvidence}</ReactMarkdown>
                        </Box>
                      </div>
                    )}

                    {/* Process Assessment Note */}
                    {selectedQuestion.processAssessmentNote && (
                      <Alert type="warning" header="Process Assessment Note">
                        <ReactMarkdown>{selectedQuestion.processAssessmentNote}</ReactMarkdown>
                      </Alert>
                    )}

                    {/* Recommendations */}
                    {selectedQuestion.recommendations && (
                      <div>
                        <Box variant="h5">
                          <SpaceBetween direction="horizontal" size="xs" alignItems="center">
                            Recommendations
                            <Button
                              iconName="gen-ai"
                              variant="inline-icon"
                              onClick={() => handleAiChatClick(selectedQuestion)}
                              ariaLabel="Ask AI for more recommendations"
                            />
                          </SpaceBetween>
                        </Box>
                        <Box variant="p" color="text-body-secondary">
                          <ReactMarkdown>{selectedQuestion.recommendations}</ReactMarkdown>
                        </Box>
                      </div>
                    )}

                    {/* Relevant Resources */}
                    {selectedQuestion.relevantResources && selectedQuestion.relevantResources.length > 0 && (
                      <div>
                        <Box variant="h5">Relevant Resources</Box>
                        <SpaceBetween direction="horizontal" size="xs">
                          {selectedQuestion.relevantResources.map((resource, idx) => (
                            <Badge key={idx} color="blue">{resource}</Badge>
                          ))}
                        </SpaceBetween>
                      </div>
                    )}
                  </SpaceBetween>
                </ExpandableSection>
              </Box>
            )}
          </ExpandableSection>
        );
      })}

      {/* Details Modal */}
      <DetailsModal
        visible={detailsModalVisible}
        onDismiss={() => setDetailsModalVisible(false)}
        content={detailsContent}
        error={detailsError || undefined}
        originalFileName={fileName}
        lensAlias={domain}
      />
    </SpaceBetween>
  );
};
