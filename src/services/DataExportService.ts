import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { prisma } from 'src/db';
import { sendMail } from 'src/mailer/mailer';
import { logAuditEvent } from 'src/utils/auditLogger';
import { appUrl } from 'src/utils/helpers';

type ExportFormat = 'json' | 'csv';

export class DataExportService {
    private static readonly exportDirectory = path.join(process.cwd(), 'storage', 'data-exports');
    private static readonly downloadTtlMs = 7 * 24 * 60 * 60 * 1000;

    static getExportFileName(requestId: string, format: string): string {
        return `data-export-${requestId}.${format}`;
    }

    static getExportFilePath(requestId: string, format: string): string {
        return path.join(this.exportDirectory, this.getExportFileName(requestId, format));
    }

    static getDownloadUrl(requestId: string): string {
        return appUrl(`api/data-export/${requestId}/download`);
    }

    static exportFileExists(requestId: string, format: string): boolean {
        return existsSync(this.getExportFilePath(requestId, format));
    }

    async processRequest(requestId: string) {
        const exportRequest = await prisma.dataExportRequest.findUnique({
            where: { id: requestId },
            include: { user: true },
        });

        if (!exportRequest || exportRequest.status === 'expired') {
            return null;
        }

        if (exportRequest.status === 'ready') {
            return exportRequest;
        }

        await prisma.dataExportRequest.update({
            where: { id: requestId },
            data: {
                status: 'processing',
                errorMessage: null,
            },
        });

        try {
            const exportPayload = await this.buildExportPayload(exportRequest.userId);
            const serializedExport =
                exportRequest.format === 'csv'
                    ? this.buildCsv(exportPayload)
                    : JSON.stringify(exportPayload, null, 2);

            const filePath = DataExportService.getExportFilePath(
                exportRequest.id,
                exportRequest.format,
            );

            await fs.mkdir(DataExportService.exportDirectory, { recursive: true });
            await fs.writeFile(filePath, serializedExport, 'utf8');

            const fileSize = Buffer.byteLength(serializedExport, 'utf8');
            const expiresAt = new Date(Date.now() + DataExportService.downloadTtlMs);
            const downloadUrl = DataExportService.getDownloadUrl(exportRequest.id);

            const updatedRequest = await prisma.dataExportRequest.update({
                where: { id: exportRequest.id },
                data: {
                    status: 'ready',
                    downloadUrl,
                    expiresAt,
                    fileSize,
                    errorMessage: null,
                },
            });

            await logAuditEvent(exportRequest.userId, 'DATA_EXPORT', {
                entityType: 'DataExportRequest',
                entityId: exportRequest.id,
                statusCode: 200,
                metadata: {
                    action: 'ready',
                    format: exportRequest.format,
                    fileSize,
                },
            });

            await sendMail({
                to: exportRequest.user.email,
                subject: 'Your Artisyn data export is ready',
                text:
                    `Your requested data export is ready.\n\n` +
                    `Download it here: ${downloadUrl}\n\n` +
                    `This link expires on ${expiresAt.toISOString()}.`,
                temp: 'auth',
                caption: 'Your export is ready',
                data: {
                    address: downloadUrl,
                },
            });

            return updatedRequest;
        } catch (error) {
            const errorMessage =
                error instanceof Error ? error.message : 'Unknown data export failure';

            const failedRequest = await prisma.dataExportRequest.update({
                where: { id: requestId },
                data: {
                    status: 'failed',
                    errorMessage,
                },
            });

            await logAuditEvent(exportRequest.userId, 'DATA_EXPORT', {
                entityType: 'DataExportRequest',
                entityId: exportRequest.id,
                statusCode: 500,
                errorMessage,
                metadata: {
                    action: 'failed',
                    format: exportRequest.format,
                },
            });

            await sendMail({
                to: exportRequest.user.email,
                subject: 'Your Artisyn data export failed',
                text:
                    'We could not complete your data export request right now. ' +
                    'Please try again later from your account settings.',
                temp: 'auth',
                caption: 'Data export failed',
            });

            return failedRequest;
        }
    }

    async buildExportPayload(userId: string) {
        const user = await prisma.user.findUnique({
            where: { id: userId },
            include: {
                location: true,
                curator: true,
                media: true,
                profile: true,
                preferences: true,
                privacySettings: true,
                linkedAccounts: true,
                applications: true,
                artisans: true,
                reviews: true,
                receivedReviews: true,
                reviewReports: true,
                sentTips: true,
                receivedTips: true,
                auditLogs: true,
                dataExportRequests: true,
            },
        });

        if (!user) {
            throw new Error('User not found for export');
        }

        const {
            password,
            emailVerificationCode,
            linkedAccounts,
            dataExportRequests,
            ...safeUser
        } = user;

        return {
            exportedAt: new Date().toISOString(),
            user: safeUser,
            linkedAccounts: linkedAccounts.map(({ accessToken, refreshToken, ...account }) => account),
            dataExportRequests,
        };
    }

    buildCsv(payload: Record<string, unknown>): string {
        const rows: string[][] = [['section', 'id', 'payload']];

        for (const [section, value] of Object.entries(payload)) {
            if (value === null || value === undefined) {
                rows.push([section, '', '']);
                continue;
            }

            if (Array.isArray(value)) {
                if (value.length === 0) {
                    rows.push([section, '', '[]']);
                    continue;
                }

                for (const item of value) {
                    rows.push([section, this.extractRowId(item), JSON.stringify(item)]);
                }

                continue;
            }

            if (typeof value === 'object') {
                rows.push([section, this.extractRowId(value), JSON.stringify(value)]);
                continue;
            }

            rows.push([section, '', String(value)]);
        }

        return rows.map((row) => row.map((cell) => this.escapeCsv(cell)).join(',')).join('\n');
    }

    private extractRowId(value: unknown): string {
        if (
            value &&
            typeof value === 'object' &&
            'id' in value &&
            typeof (value as { id?: unknown }).id === 'string'
        ) {
            return (value as { id: string }).id;
        }

        return '';
    }

    private escapeCsv(value: string): string {
        const normalizedValue = value.replaceAll('"', '""');
        return /[",\n]/.test(normalizedValue)
            ? `"${normalizedValue}"`
            : normalizedValue;
    }
}

export const dataExportService = new DataExportService();