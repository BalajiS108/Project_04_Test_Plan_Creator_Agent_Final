import ExcelJS from 'exceljs';
import path from 'path';
import fs from 'fs';
import { ExecutionReport } from './agent.js';

export async function generateExcelReport(report: ExecutionReport): Promise<string> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Intelligent Test Planning Agent';
    workbook.created = new Date();

    // ── Summary Sheet ──
    const summarySheet = workbook.addWorksheet('Summary', {
        properties: { tabColor: { argb: '3B82F6' } }
    });

    summarySheet.columns = [
        { header: 'Metric', key: 'metric', width: 25 },
        { header: 'Value', key: 'value', width: 30 },
    ];

    // Header styling
    summarySheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' }, size: 12 };
    summarySheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '3B82F6' } };

    const summaryRows = [
        { metric: 'Executed At', value: new Date(report.summary.executedAt).toLocaleString() },
        { metric: 'Total Test Cases', value: report.summary.total },
        { metric: 'Passed', value: report.summary.passed },
        { metric: 'Failed', value: report.summary.failed },
        { metric: 'Errors', value: report.summary.errors },
        { metric: 'Skipped', value: report.summary.skipped },
        { metric: 'Pass Rate', value: `${report.summary.total > 0 ? Math.round((report.summary.passed / report.summary.total) * 100) : 0}%` },
        { metric: 'Total Duration', value: `${(report.summary.duration / 1000).toFixed(1)}s` },
    ];
    summaryRows.forEach(r => summarySheet.addRow(r));

    // Color code pass/fail rows
    summarySheet.getRow(4).getCell(2).font = { bold: true, color: { argb: '16A34A' } }; // Passed
    summarySheet.getRow(5).getCell(2).font = { bold: true, color: { argb: 'DC2626' } }; // Failed

    // ── Detailed Results Sheet ──
    const detailSheet = workbook.addWorksheet('Test Results', {
        properties: { tabColor: { argb: '10B981' } }
    });

    detailSheet.columns = [
        { header: '#', key: 'id', width: 5 },
        { header: 'Test Case', key: 'name', width: 40 },
        { header: 'Jira Key', key: 'jiraKey', width: 15 },
        { header: 'Priority', key: 'priority', width: 12 },
        { header: 'Status', key: 'status', width: 12 },
        { header: 'Expected Result', key: 'expected', width: 40 },
        { header: 'Actual Result', key: 'actual', width: 40 },
        { header: 'Duration', key: 'duration', width: 12 },
        { header: 'Error', key: 'error', width: 30 },
    ];

    detailSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' }, size: 11 };
    detailSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '10B981' } };

    for (const r of report.results) {
        const row = detailSheet.addRow({
            id: r.id,
            name: r.name,
            jiraKey: r.jiraKey,
            priority: r.priority,
            status: r.status,
            expected: r.expectedResult,
            actual: r.actualResult,
            duration: `${(r.duration / 1000).toFixed(1)}s`,
            error: r.error || '',
        });

        // Status cell colors
        const statusCell = row.getCell(5);
        if (r.status === 'PASS') {
            statusCell.font = { bold: true, color: { argb: '16A34A' } };
            statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'DCFCE7' } };
        } else if (r.status === 'FAIL') {
            statusCell.font = { bold: true, color: { argb: 'DC2626' } };
            statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FEE2E2' } };
        } else if (r.status === 'ERROR') {
            statusCell.font = { bold: true, color: { argb: 'EA580C' } };
            statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7ED' } };
        }

        // Priority cell colors
        const prioCell = row.getCell(4);
        if (r.priority.toLowerCase() === 'high') {
            prioCell.font = { bold: true, color: { argb: 'DC2626' } };
        } else if (r.priority.toLowerCase() === 'medium') {
            prioCell.font = { color: { argb: 'EA580C' } };
        }
    }

    // ── Step Details Sheet ──
    const stepsSheet = workbook.addWorksheet('Step Details', {
        properties: { tabColor: { argb: '8B5CF6' } }
    });

    stepsSheet.columns = [
        { header: 'TC #', key: 'tcId', width: 8 },
        { header: 'Test Case', key: 'tcName', width: 35 },
        { header: 'Step', key: 'step', width: 50 },
        { header: 'Result', key: 'result', width: 50 },
        { header: 'Passed', key: 'passed', width: 10 },
    ];

    stepsSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' }, size: 11 };
    stepsSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '8B5CF6' } };

    for (const r of report.results) {
        for (const s of r.steps) {
            const row = stepsSheet.addRow({
                tcId: r.id,
                tcName: r.name,
                step: s.step,
                result: s.result,
                passed: s.passed ? '✓' : '✗',
            });
            const passedCell = row.getCell(5);
            passedCell.font = { bold: true, color: { argb: s.passed ? '16A34A' : 'DC2626' } };
        }
    }

    // Save
    const reportsDir = path.join(process.cwd(), 'reports');
    if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir, { recursive: true });
    }

    const filename = `TestReport_${Date.now()}.xlsx`;
    const filePath = path.join(reportsDir, filename);
    await workbook.xlsx.writeFile(filePath);
    console.log(`📊 Excel report saved: ${filePath}`);

    return filePath;
}

export async function generateHtmlReport(report: ExecutionReport): Promise<string> {
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Test Execution Report - ${new Date(report.summary.executedAt).toLocaleDateString()}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Inter', sans-serif; background-color: #f8fafc; }
        .stat-card { transition: transform 0.2s; }
        .stat-card:hover { transform: translateY(-4px); }
    </style>
</head>
<body class="p-8">
    <div class="max-w-6xl mx-auto">
        <header class="mb-10 flex justify-between items-end">
            <div>
                <h1 class="text-4xl font-extrabold text-slate-900 tracking-tight">Test Execution Report</h1>
                <p class="text-slate-500 mt-2 font-medium">Executed At: ${new Date(report.summary.executedAt).toLocaleString()}</p>
            </div>
            <div class="text-right">
                <span class="px-4 py-2 bg-blue-600 text-white rounded-full text-sm font-bold shadow-lg shadow-blue-200">
                    Pass Rate: ${report.summary.total > 0 ? Math.round((report.summary.passed / report.summary.total) * 100) : 0}%
                </span>
            </div>
        </header>

        <div class="grid grid-cols-1 md:grid-cols-4 gap-6 mb-10">
            <div class="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 stat-card">
                <p class="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">Total Tests</p>
                <p class="text-3xl font-black text-slate-900">${report.summary.total}</p>
            </div>
            <div class="bg-emerald-50 p-6 rounded-2xl shadow-sm border border-emerald-100 stat-card">
                <p class="text-xs font-bold text-emerald-600 uppercase tracking-widest mb-1">Passed</p>
                <p class="text-3xl font-black text-emerald-700">${report.summary.passed}</p>
            </div>
            <div class="bg-red-50 p-6 rounded-2xl shadow-sm border border-red-100 stat-card">
                <p class="text-xs font-bold text-red-600 uppercase tracking-widest mb-1">Failed</p>
                <p class="text-3xl font-black text-red-700">${report.summary.failed}</p>
            </div>
            <div class="bg-blue-50 p-6 rounded-2xl shadow-sm border border-blue-100 stat-card">
                <p class="text-xs font-bold text-blue-600 uppercase tracking-widest mb-1">Duration</p>
                <p class="text-3xl font-black text-blue-700">${(report.summary.duration / 1000).toFixed(1)}s</p>
            </div>
        </div>

        <div class="bg-white rounded-3xl shadow-xl overflow-hidden border border-slate-100">
            <div class="px-8 py-6 bg-slate-50 border-b border-slate-100">
                <h2 class="text-xl font-bold text-slate-800">Detailed Test Results</h2>
            </div>
            <div class="overflow-x-auto">
                <table class="w-full text-left border-collapse">
                    <thead>
                        <tr class="bg-slate-50/50">
                            <th class="px-8 py-4 text-xs font-bold text-slate-400 uppercase tracking-widest">Test Case</th>
                            <th class="px-8 py-4 text-xs font-bold text-slate-400 uppercase tracking-widest">Status</th>
                            <th class="px-8 py-4 text-xs font-bold text-slate-400 uppercase tracking-widest">Duration</th>
                            <th class="px-8 py-4 text-xs font-bold text-slate-400 uppercase tracking-widest">Actual Result</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y divide-slate-100">
                        ${report.results.map(r => `
                            <tr class="hover:bg-slate-50/50 transition-colors">
                                <td class="px-8 py-5">
                                    <p class="text-sm font-bold text-slate-800">TC-${r.id}: ${r.name}</p>
                                    <p class="text-[10px] font-bold text-blue-500 mt-1 uppercase tracking-tighter">${r.jiraKey}</p>
                                </td>
                                <td class="px-8 py-5">
                                    <span class="px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest ${
                                        r.status === 'PASS' ? 'bg-emerald-100 text-emerald-700' : 
                                        r.status === 'FAIL' ? 'bg-red-100 text-red-700' : 'bg-orange-100 text-orange-700'
                                    }">
                                        ${r.status}
                                    </span>
                                </td>
                                <td class="px-8 py-5 text-sm text-slate-500">${(r.duration / 1000).toFixed(1)}s</td>
                                <td class="px-8 py-5 text-sm text-slate-600">${r.actualResult || r.error || 'N/A'}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        </div>

        <footer class="mt-12 text-center text-slate-400 text-sm pb-12">
            Generated by Smart Test Plan Creator Agent &copy; ${new Date().getFullYear()}
        </footer>
    </div>
</body>
</html>
    `;

    const reportsDir = path.join(process.cwd(), 'reports');
    if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir, { recursive: true });
    }

    const filename = `TestReport_${Date.now()}.html`;
    const filePath = path.join(reportsDir, filename);
    fs.writeFileSync(filePath, html);
    console.log(`📊 HTML report saved: ${filePath}`);

    return filePath;
}
