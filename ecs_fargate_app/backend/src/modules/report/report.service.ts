import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AwsConfigService } from '../../config/aws.config';
import { GetLensReviewReportCommand } from '@aws-sdk/client-wellarchitected';
import { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import * as PDFDocument from 'pdfkit';
import * as fs from 'fs';
import * as path from 'path';

interface AnalysisResult {
  pillar: string;
  question: string;
  bestPractices: {
    name: string;
    relevant: boolean;
    applied: boolean;
    reasonApplied?: string;
    reasonNotApplied?: string;
    recommendations?: string;
  }[];
}

interface SMAAnalysisResult {
  pillar: string;
  question: string;
  questionId: string;
  category?: string;
  maturityLevel?: number | null;
  confidence?: string;
  iacEvidence?: string | null;
  maturityJustification?: string;
  processAssessmentNote?: string | null;
  recommendations?: string;
  relevantResources?: string[];
}

interface PillarSummary {
  pillar: string;
  avgMaturity: number;
  questionCount: number;
  highConfidence: number;
  processNotes: number;
}

interface BedrockReportContent {
  executiveSummary: string;
  pillarAnalyses: { pillar: string; summary: string; strengths: string[]; gaps: string[] }[];
  roadmap: { priority: number; title: string; action: string; pillar: string; currentLevel: number; targetLevel: number; effort: string; impact: string }[];
}

@Injectable()
export class ReportService {
  private readonly logger = new Logger(ReportService.name);
  private readonly lensAliasArn = 'arn:aws:wellarchitected::aws:lens/wellarchitected';

  constructor(private readonly awsConfig: AwsConfigService, private readonly configService: ConfigService) {}

  async generateReport(workloadId: string, lensAliasArn?: string) {
    try {
      const waClient = this.awsConfig.createWAClient();
      const command = new GetLensReviewReportCommand({ WorkloadId: workloadId, LensAlias: lensAliasArn || this.lensAliasArn });
      const response = await waClient.send(command);
      return response.LensReviewReport?.Base64String;
    } catch (error) {
      this.logger.error('Error generating report:', error);
      throw new Error(error);
    }
  }

  generateRecommendationsCsv(results: AnalysisResult[]): string {
    try {
      const rows = [['Pillar', 'Question', 'Best Practice', 'Relevant', 'Applied', 'Reason', 'Recommendations']];
      for (const result of results) {
        for (const bp of result.bestPractices) {
          rows.push([result.pillar, result.question, bp.name, bp.relevant ? 'Yes' : 'No', bp.applied ? 'Yes' : 'No', bp.applied ? (bp.reasonApplied || '') : (bp.reasonNotApplied || ''), bp.recommendations || '']);
        }
      }
      return rows.map(row => row.map(cell => `"${cell}"`).join(',')).join('\n');
    } catch (error) {
      this.logger.error('Error generating recommendations CSV:', error);
      throw new Error(error);
    }
  }

  generateSMARecommendationsCsv(results: SMAAnalysisResult[]): string {
    try {
      const stripMarkdown = (text: string | null | undefined): string => {
        if (!text) return '';
        return text.replace(/\*\*(.*?)\*\*/g, '$1').replace(/`(.*?)`/g, '$1').replace(/^[-*] /gm, '• ').replace(/^\d+\.\s/gm, (m) => m).replace(/\n{2,}/g, '\n').trim();
      };
      const rows = [['Pillar', 'Category', 'Question', 'Question ID', 'Maturity Level', 'Confidence', 'IaC Evidence', 'Maturity Justification', 'Process Assessment Note', 'Recommendations', 'Relevant Resources']];
      for (const result of results) {
        rows.push([result.pillar, result.category || '', result.question, result.questionId, result.maturityLevel != null ? `${result.maturityLevel}/5` : 'N/A', result.confidence || '', stripMarkdown(result.iacEvidence), stripMarkdown(result.maturityJustification), stripMarkdown(result.processAssessmentNote), stripMarkdown(result.recommendations), (result.relevantResources || []).join('; ')]);
      }
      return rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
    } catch (error) {
      this.logger.error('Error generating SMA recommendations CSV:', error);
      throw new Error(error);
    }
  }

  async generateSMAReport(results: SMAAnalysisResult[], fileName: string = 'unknown_file', outputLanguage: string = 'en'): Promise<Buffer> {
    this.logger.log(`Generating SMA PDF report for ${results.length} questions`);
    const pillarSummaries = this.buildPillarSummaries(results);
    const overallMaturity = this.calculateOverallMaturity(results);
    const bedrockReport = await this.generateBedrockReportContent(results, pillarSummaries, overallMaturity, outputLanguage);
    return this.buildSMAPdf(bedrockReport, results, pillarSummaries, overallMaturity, fileName);
  }

  private buildPillarSummaries(results: SMAAnalysisResult[]): PillarSummary[] {
    const pillarMap = new Map<string, SMAAnalysisResult[]>();
    results.forEach(r => { const list = pillarMap.get(r.pillar) || []; list.push(r); pillarMap.set(r.pillar, list); });
    return Array.from(pillarMap.entries()).map(([pillar, questions]) => {
      const vals = questions.map(q => q.maturityLevel).filter((v): v is number => v != null);
      const avg = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
      return { pillar, avgMaturity: Math.round(avg * 10) / 10, questionCount: questions.length, highConfidence: questions.filter(q => q.confidence === 'high').length, processNotes: questions.filter(q => q.processAssessmentNote).length };
    });
  }

  private calculateOverallMaturity(results: SMAAnalysisResult[]): number {
    const vals = results.map(r => r.maturityLevel).filter((v): v is number => v != null);
    if (vals.length === 0) return 0;
    return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
  }

  private async generateBedrockReportContent(results: SMAAnalysisResult[], pillarSummaries: PillarSummary[], overallMaturity: number, outputLanguage: string): Promise<BedrockReportContent> {
    const bedrockClient = this.awsConfig.createBedrockClient();
    const modelId = this.configService.get<string>('aws.bedrock.modelId');
    const stripMd = (text: string | null | undefined): string => {
      if (!text) return '';
      return text.replace(/\*\*(.*?)\*\*/g, '$1').replace(/`(.*?)`/g, '$1').replace(/^[-*] /gm, '• ').trim();
    };
    const resultsContext = results.map(r => ({ pillar: r.pillar, category: r.category, question: r.question, maturityLevel: r.maturityLevel, confidence: r.confidence, iacEvidence: stripMd(r.iacEvidence), justification: stripMd(r.maturityJustification), processNote: stripMd(r.processAssessmentNote), recommendations: stripMd(r.recommendations) }));
    const pillarContext = pillarSummaries.map(p => `${p.pillar}: avg ${p.avgMaturity}/5 (${p.questionCount} questions, ${p.highConfidence} high confidence)`).join('\n');
    const languageNote = outputLanguage !== 'en' ? `\nIMPORTANT: Write the entire report in the language with code "${outputLanguage}". Keep AWS service names and technical terms in English.` : '';

    const systemPrompt = `You are an AWS Senior Solutions Architect writing a SaaS Maturity Assessment report for a customer. Generate a structured report based on the assessment results provided.${languageNote}

Return your response as JSON with this exact structure:
{
  "executiveSummary": "2-3 paragraph executive summary of the overall SaaS maturity posture, key strengths, and critical gaps",
  "pillarAnalyses": [
    { "pillar": "pillar name", "summary": "2-3 sentence summary", "strengths": ["strength 1"], "gaps": ["gap 1"] }
  ],
  "roadmap": [
    { "priority": 1, "title": "short 3-6 word title for this improvement", "action": "specific action to take with details", "pillar": "which pillar", "currentLevel": 2, "targetLevel": 3, "effort": "Low|Medium|High", "impact": "Low|Medium|High" }
  ]
}

Rules:
- Executive summary should be professional and actionable
- Pillar analyses should reference specific findings from the assessment
- Roadmap should have 5-8 prioritized actions, ordered by impact/effort ratio
- Each roadmap item MUST have a concise title (3-6 words) summarizing the improvement
- Be specific about AWS services and configurations
- Do NOT include markdown formatting in any field`;

    const userPrompt = `Assessment Results:\nOverall Maturity: ${overallMaturity}/5\n\nPillar Averages:\n${pillarContext}\n\nDetailed Results:\n${JSON.stringify(resultsContext, null, 2)}`;

    try {
      const command = new ConverseCommand({ modelId, messages: [{ role: 'user', content: [{ text: userPrompt }] }], system: [{ text: systemPrompt }], inferenceConfig: { maxTokens: 4096, temperature: 0.3 } });
      const response = await bedrockClient.send(command);
      const responseText = response.output?.message?.content?.[0]?.['text'] || '';
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) { this.logger.warn('Could not parse Bedrock report response, using fallback'); return this.buildFallbackReportContent(pillarSummaries, overallMaturity); }
      return JSON.parse(jsonMatch[0]) as BedrockReportContent;
    } catch (error) {
      this.logger.error('Bedrock report generation failed, using fallback:', error);
      return this.buildFallbackReportContent(pillarSummaries, overallMaturity);
    }
  }

  private buildFallbackReportContent(pillarSummaries: PillarSummary[], overallMaturity: number): BedrockReportContent {
    return {
      executiveSummary: `This SaaS Maturity Assessment evaluated the infrastructure across ${pillarSummaries.length} pillars with an overall maturity score of ${overallMaturity}/5.`,
      pillarAnalyses: pillarSummaries.map(p => ({ pillar: p.pillar, summary: `Average maturity of ${p.avgMaturity}/5 across ${p.questionCount} questions.`, strengths: [], gaps: [] })),
      roadmap: [],
    };
  }

  private buildSMAPdf(report: BedrockReportContent, results: SMAAnalysisResult[], pillarSummaries: PillarSummary[], overallMaturity: number, fileName: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 60 });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const C = { primary: '#0972d3', primaryDark: '#033160', dark: '#232f3e', secondary: '#687078', accent: '#037f0c', warning: '#d91515', lightBg: '#f2f8fd', lightGrey: '#fafafa', border: '#e1e4e8', white: '#ffffff', orange: '#ff9900' };
      const M = 60;
      const W = doc.page.width - M * 2;
      const usable = doc.page.height - 70;

      // Load logo
      let logo: Buffer | null = null;
      try {
        for (const p of [path.resolve(__dirname, '..', '..', 'assets', 'aws-logo.png'), path.resolve(process.cwd(), 'dist', 'assets', 'aws-logo.png'), path.resolve(process.cwd(), 'src', 'assets', 'aws-logo.png')]) {
          if (fs.existsSync(p)) { logo = fs.readFileSync(p); this.logger.log(`AWS logo loaded from: ${p}`); break; }
        }
        if (!logo) this.logger.warn('AWS logo not found');
      } catch (e) { this.logger.warn('Failed to load AWS logo:', e); }

      const addPg = () => { doc.addPage(); doc.y = M; };
      const hdr = (t: string) => { const y = doc.y; doc.rect(M, y, 4, 22).fill(C.orange); doc.fontSize(16).font('Helvetica-Bold').fillColor(C.primaryDark).text(t, M + 14, y + 2, { lineBreak: false }); doc.font('Helvetica'); doc.y = y + 30; doc.moveTo(M, doc.y).lineTo(doc.page.width - M, doc.y).lineWidth(0.5).stroke(C.border); doc.moveDown(1); };
      const space = (n: number) => { if (doc.y + n > usable) addPg(); };
      const mCol = (l: number) => l <= 2 ? C.warning : l === 3 ? C.primary : C.accent;
      const bCol = (v: string) => v === 'Low' ? C.accent : v === 'Medium' ? C.primary : C.warning;

      // ── COVER PAGE ──
      doc.rect(0, 0, doc.page.width, 6).fill(C.orange);
      if (logo) { try { doc.image(logo, doc.page.width / 2 - 40, 40, { fit: [80, 30] }); } catch (_) { /* skip */ } }
      doc.y = 90;
      doc.fontSize(22).font('Helvetica-Bold').fillColor(C.primaryDark).text('AWS Support', M, doc.y, { width: W, align: 'center' });
      doc.moveDown(0.3);
      doc.fontSize(22).font('Helvetica-Bold').fillColor(C.primaryDark).text('SaaS Maturity Assessment', M, doc.y, { width: W, align: 'center' });
      doc.font('Helvetica').moveDown(0.3);
      doc.fontSize(12).fillColor(C.secondary).text('Assessment Report', M, doc.y, { width: W, align: 'center' });
      doc.moveDown(3);

      // Score circle
      const sx = doc.page.width / 2, sy = doc.y, sr = 40;
      doc.circle(sx, sy + sr, sr).fill(C.lightBg);
      doc.circle(sx, sy + sr, sr).lineWidth(2.5).stroke(C.primary);
      doc.fontSize(32).font('Helvetica-Bold').fillColor(C.primary).text(`${overallMaturity}`, sx - 35, sy + sr - 18, { width: 70, align: 'center', lineBreak: false });
      doc.fontSize(9).font('Helvetica').fillColor(C.secondary).text('out of 5.0', sx - 35, sy + sr + 12, { width: 70, align: 'center', lineBreak: false });
      doc.y = sy + sr * 2 + 16;
      doc.fontSize(11).font('Helvetica-Bold').fillColor(C.dark).text('Overall Maturity Score', M, doc.y, { width: W, align: 'center' });
      doc.font('Helvetica').moveDown(2.5);

      // Pillar bars
      const bx = M + 30, bw = W - 60;
      pillarSummaries.forEach(p => {
        const y = doc.y, fw = (p.avgMaturity / 5) * bw, col = mCol(Math.round(p.avgMaturity));
        doc.fontSize(9).font('Helvetica-Bold').fillColor(C.dark).text(p.pillar, bx, y, { lineBreak: false });
        doc.fontSize(9).font('Helvetica-Bold').fillColor(col).text(`${p.avgMaturity}/5`, bx + bw - 35, y, { width: 35, align: 'right', lineBreak: false });
        doc.font('Helvetica');
        const by = y + 14;
        doc.roundedRect(bx, by, bw, 8, 3).fill(C.border);
        if (fw > 0) doc.roundedRect(bx, by, Math.max(fw, 6), 8, 3).fill(col);
        doc.y = by + 20;
      });

      doc.moveDown(2);
      doc.fontSize(8.5).fillColor(C.secondary).text(`Source: ${fileName}`, M, doc.y, { width: W, align: 'center' });
      doc.moveDown(0.3);
      doc.fontSize(8.5).fillColor(C.secondary).text(`Generated: ${new Date().toISOString().split('T')[0]}`, M, doc.y, { width: W, align: 'center' });
      doc.moveDown(0.3);
      doc.fontSize(8.5).fillColor(C.secondary).text(`${results.length} questions across ${pillarSummaries.length} pillars`, M, doc.y, { width: W, align: 'center' });

      // ── EXECUTIVE SUMMARY ──
      addPg(); hdr('Executive Summary');
      report.executiveSummary.split(/\n\n+/).filter(p => p.trim()).forEach((para, idx, arr) => {
        space(60);
        doc.fontSize(10).fillColor(C.dark).text(para.trim(), M, doc.y, { width: W, lineGap: 5, paragraphGap: 4 });
        if (idx < arr.length - 1) doc.moveDown(0.8);
      });

      // ── PRIORITIZED IMPROVEMENT ROADMAP ──
      if (report.roadmap?.length > 0) {
        addPg(); hdr('Prioritized Improvement Roadmap');
        report.roadmap.forEach((item, idx) => {
          const title = item.title || item.action.substring(0, 50);
          doc.fontSize(9).font('Helvetica');
          const dH = doc.heightOfString(item.action, { width: W - 55 });
          const cH = Math.max(82, dH + 70);
          space(cH + 12);
          const cy = doc.y;
          doc.rect(M, cy, W, cH).fill(C.lightGrey);
          doc.rect(M, cy, 4, cH).fill(C.orange);
          doc.circle(M + 20, cy + 15, 9).fill(C.primaryDark);
          doc.fontSize(10).font('Helvetica-Bold').fillColor(C.white).text(`${idx + 1}`, M + 12, cy + 10, { width: 16, align: 'center', lineBreak: false });
          doc.fontSize(11).font('Helvetica-Bold').fillColor(C.primaryDark).text(title, M + 40, cy + 8, { width: W - 50, lineBreak: false });
          doc.fontSize(9).font('Helvetica').fillColor(C.dark).text(item.action, M + 40, cy + 24, { width: W - 55, lineGap: 2 });
          const dEnd = doc.y;
          const my = Math.max(cy + 52, dEnd + 6);
          let mx = M + 40;
          doc.fontSize(7.5).fillColor(C.secondary).text('Pillar:', mx, my, { lineBreak: false }); mx += 28;
          doc.fontSize(7.5).font('Helvetica-Bold').fillColor(C.dark).text(item.pillar, mx, my, { lineBreak: false }); doc.font('Helvetica');
          mx += doc.widthOfString(item.pillar) + 12;
          doc.fontSize(7.5).fillColor(C.secondary).text('Current:', mx, my, { lineBreak: false }); mx += 34;
          doc.fontSize(7.5).font('Helvetica-Bold').fillColor(C.warning).text(`${item.currentLevel}/5`, mx, my, { lineBreak: false }); doc.font('Helvetica');
          mx += 24;
          doc.fontSize(7.5).fillColor(C.secondary).text('Target:', mx, my, { lineBreak: false }); mx += 30;
          doc.fontSize(7.5).font('Helvetica-Bold').fillColor(C.accent).text(`${item.targetLevel}/5`, mx, my, { lineBreak: false }); doc.font('Helvetica');
          const br = my + 14; let bx2 = M + 40;
          doc.fontSize(7).fillColor(C.secondary).text('Effort:', bx2, br + 2, { lineBreak: false }); bx2 += 28;
          doc.roundedRect(bx2, br, 36, 12, 3).fill(bCol(item.effort));
          doc.fontSize(6.5).font('Helvetica-Bold').fillColor(C.white).text(item.effort, bx2, br + 2.5, { width: 36, align: 'center', lineBreak: false }); doc.font('Helvetica'); bx2 += 48;
          doc.fontSize(7).fillColor(C.secondary).text('Impact:', bx2, br + 2, { lineBreak: false }); bx2 += 30;
          doc.roundedRect(bx2, br, 36, 12, 3).fill(bCol(item.impact));
          doc.fontSize(6.5).font('Helvetica-Bold').fillColor(C.white).text(item.impact, bx2, br + 2.5, { width: 36, align: 'center', lineBreak: false }); doc.font('Helvetica');
          doc.y = cy + cH + 10;
        });
      }

      // ── PILLAR ANALYSIS ──
      addPg(); hdr('Pillar Analysis');
      for (const pa of report.pillarAnalyses) {
        space(160);
        const ps = pillarSummaries.find(p => p.pillar === pa.pillar);
        const score = ps?.avgMaturity ?? 0;
        const pCol = mCol(Math.round(score));

        const cy = doc.y;
        doc.rect(M, cy, W, 34).fill(C.lightBg);
        doc.rect(M, cy, 4, 34).fill(pCol);
        doc.fontSize(12).font('Helvetica-Bold').fillColor(C.primaryDark).text(pa.pillar, M + 14, cy + 9, { width: W - 80, lineBreak: false });
        const bx3 = doc.page.width - M - 50;
        doc.roundedRect(bx3, cy + 7, 40, 20, 4).fill(pCol);
        doc.fontSize(10).font('Helvetica-Bold').fillColor(C.white).text(`${score}/5`, bx3, cy + 11, { width: 40, align: 'center', lineBreak: false });
        doc.font('Helvetica');
        doc.y = cy + 44;

        doc.fontSize(9.5).fillColor(C.dark).text(pa.summary, M, doc.y, { width: W, lineGap: 3 });
        doc.moveDown(0.8);

        if (pa.strengths?.length > 0) {
          space(30 + pa.strengths.length * 24);
          doc.fontSize(10).font('Helvetica-Bold').fillColor(C.accent).text('Strengths', M, doc.y);
          doc.font('Helvetica').moveDown(0.4);
          pa.strengths.forEach(s => { space(26); const y = doc.y; doc.circle(M + 8, y + 5, 2.5).fill(C.accent); doc.fontSize(9.5).fillColor(C.dark).text(s, M + 20, y, { width: W - 20, lineGap: 3 }); doc.moveDown(0.4); });
          doc.moveDown(0.5);
        }

        if (pa.gaps?.length > 0) {
          space(30 + pa.gaps.length * 24);
          doc.fontSize(10).font('Helvetica-Bold').fillColor(C.warning).text('Gaps', M, doc.y);
          doc.font('Helvetica').moveDown(0.4);
          pa.gaps.forEach(g => { space(26); const y = doc.y; doc.circle(M + 8, y + 5, 2.5).fill(C.warning); doc.fontSize(9.5).fillColor(C.dark).text(g, M + 20, y, { width: W - 20, lineGap: 3 }); doc.moveDown(0.4); });
          doc.moveDown(0.5);
        }

        doc.moveDown(0.3);
        if (doc.y < usable - 20) { doc.moveTo(M + 20, doc.y).lineTo(doc.page.width - M - 20, doc.y).dash(3, { space: 3 }).stroke(C.border); doc.undash(); doc.moveDown(1); }
      }

      // ── DETAILED RESULTS TABLE ──
      addPg(); hdr('Detailed Assessment Results');

      // Table config
      const colW = { q: W * 0.38, mat: 45, conf: 50, just: W * 0.35 };
      const pad = 6;
      const headerH = 22;

      const drawTableHeader = () => {
        const y = doc.y;
        doc.rect(M, y, W, headerH).fill(C.primaryDark);
        doc.fontSize(8).font('Helvetica-Bold').fillColor(C.white);
        let cx = M + pad;
        doc.text('Question', cx, y + 6, { width: colW.q - pad * 2, lineBreak: false }); cx += colW.q;
        doc.text('Maturity', cx, y + 6, { width: colW.mat - pad * 2, lineBreak: false }); cx += colW.mat;
        doc.text('Confidence', cx, y + 6, { width: colW.conf - pad * 2, lineBreak: false }); cx += colW.conf;
        doc.text('Justification', cx, y + 6, { width: colW.just - pad * 2, lineBreak: false });
        doc.font('Helvetica');
        doc.y = y + headerH;
      };

      drawTableHeader();

      results.forEach((r, idx) => {
        doc.fontSize(8).font('Helvetica');
        const qH = doc.heightOfString(r.question, { width: colW.q - pad * 2 });
        const jText = r.maturityJustification ? r.maturityJustification.replace(/\*\*(.*?)\*\*/g, '$1').replace(/`(.*?)`/g, '$1').replace(/Evidence:[\s\S]*$/i, '').replace(/IaC Evidence:[\s\S]*$/i, '').replace(/Relevant Resources:[\s\S]*$/i, '').trim().substring(0, 200) : '';
        const jH = jText ? doc.heightOfString(jText, { width: colW.just - pad * 2 }) : 12;
        const rowH = Math.max(22, Math.max(qH, jH) + pad * 2 + 2);

        if (doc.y + rowH > usable) { addPg(); drawTableHeader(); }

        const ry = doc.y;
        const bg = idx % 2 === 0 ? C.white : C.lightGrey;
        doc.rect(M, ry, W, rowH).fill(bg);
        doc.rect(M, ry, W, rowH).lineWidth(0.3).stroke(C.border);

        let cx = M + pad;
        doc.fontSize(7.5).fillColor(C.dark).text(r.question, cx, ry + pad, { width: colW.q - pad * 2, lineGap: 1.5 }); cx += colW.q;

        // Maturity badge
        const ml = r.maturityLevel != null ? r.maturityLevel : 0;
        const mc = mCol(Math.round(ml));
        doc.roundedRect(cx + 4, ry + pad, 28, 12, 3).fill(mc);
        doc.fontSize(7).font('Helvetica-Bold').fillColor(C.white).text(`${ml}/5`, cx + 4, ry + pad + 2, { width: 28, align: 'center', lineBreak: false });
        doc.font('Helvetica'); cx += colW.mat;

        // Confidence
        const confCol = r.confidence === 'high' ? C.accent : r.confidence === 'medium' ? C.primary : C.secondary;
        doc.fontSize(7.5).fillColor(confCol).text(r.confidence || 'N/A', cx, ry + pad, { width: colW.conf - pad * 2, lineBreak: false }); cx += colW.conf;

        // Justification
        doc.fontSize(7).fillColor(C.dark).text(jText || '-', cx, ry + pad, { width: colW.just - pad * 2, lineGap: 1.2 });

        doc.y = ry + rowH;
      });

      doc.end();
    });
  }
}
