import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import { Public } from '../auth/public.decorator';
import { OnboardingService } from './onboarding.service';
import { PortalService } from './portal.service';
import { LoginService } from './login.service';
import { DeepDiscoveryService } from './deep-discovery.service';
import { SyncService } from './sync.service';
import {
  ApplyResultsRequestDto,
  ConfirmPortalRequestDto,
  CourseImportSelectionDto,
  CredentialLoginRequestDto,
  LoginBridgeRequestDto,
  ManualPortalRequestDto,
  StartOnboardingRequestDto,
} from './dto/onboarding.request.dto';

@ApiTags('onboarding')
@ApiBearerAuth()
@Controller('onboarding')
export class OnboardingController {
  constructor(
    private readonly onboarding: OnboardingService,
    private readonly portal: PortalService,
    private readonly login: LoginService,
    private readonly deepDiscovery: DeepDiscoveryService,
    private readonly sync: SyncService,
  ) {}

  @Post('start')
  start(@CurrentUser('id') userId: string, @Body() dto: StartOnboardingRequestDto) {
    return this.onboarding.start(userId, dto);
  }

  /** School-first: start without a Course Rep account. */
  @Public()
  @Post('start-guest')
  async startGuest(@Body() dto: StartOnboardingRequestDto) {
    // Create session first with placeholder guest metadata, then bind token to session id.
    const provisional = await this.onboarding.startGuest(dto, {
      token: '',
      tokenHash: 'pending',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    const guest = this.login.issueGuestToken(provisional.onboardingSessionId);
    await this.onboarding.attachGuestToken(provisional.onboardingSessionId, guest);
    return {
      onboardingSessionId: provisional.onboardingSessionId,
      stage: provisional.stage,
      guestToken: guest.token,
      expiresAt: guest.expiresAt,
    };
  }

  @Get(':sessionId')
  async status(
    @CurrentUser('id') userId: string | undefined,
    @Param('sessionId') sessionId: string,
    @Headers('x-onboarding-guest-token') guestToken?: string,
  ) {
    const actor = await this.login.resolveActor(sessionId, userId, guestToken);
    return this.onboarding.getStatus(actor, sessionId);
  }

  @Post(':sessionId/cancel')
  async cancel(
    @CurrentUser('id') userId: string | undefined,
    @Param('sessionId') sessionId: string,
    @Headers('x-onboarding-guest-token') guestToken?: string,
  ) {
    const actor = await this.login.resolveActor(sessionId, userId, guestToken);
    return this.onboarding.cancel(actor, sessionId);
  }

  @Post(':sessionId/discover-portal')
  async discoverPortal(
    @CurrentUser('id') userId: string | undefined,
    @Param('sessionId') sessionId: string,
    @Headers('x-onboarding-guest-token') guestToken?: string,
  ) {
    const actor = await this.login.resolveActor(sessionId, userId, guestToken);
    return this.portal.discover(actor, sessionId);
  }

  @Get(':sessionId/portal-candidates')
  async portalCandidates(
    @CurrentUser('id') userId: string | undefined,
    @Param('sessionId') sessionId: string,
    @Headers('x-onboarding-guest-token') guestToken?: string,
  ) {
    const actor = await this.login.resolveActor(sessionId, userId, guestToken);
    return this.portal.listCandidates(actor, sessionId);
  }

  @Post(':sessionId/confirm-portal')
  async confirmPortal(
    @CurrentUser('id') userId: string | undefined,
    @Param('sessionId') sessionId: string,
    @Body() dto: ConfirmPortalRequestDto,
    @Headers('x-onboarding-guest-token') guestToken?: string,
  ) {
    const actor = await this.login.resolveActor(sessionId, userId, guestToken);
    return this.portal.confirm(actor, sessionId, dto);
  }

  @Post(':sessionId/confirm-portal-manual')
  async confirmPortalManual(
    @CurrentUser('id') userId: string | undefined,
    @Param('sessionId') sessionId: string,
    @Body() dto: ManualPortalRequestDto,
    @Headers('x-onboarding-guest-token') guestToken?: string,
  ) {
    const actor = await this.login.resolveActor(sessionId, userId, guestToken);
    return this.portal.confirmManual(actor, sessionId, dto);
  }

  @Post(':sessionId/login/start')
  async loginStart(
    @CurrentUser('id') userId: string | undefined,
    @Param('sessionId') sessionId: string,
    @Headers('x-onboarding-guest-token') guestToken?: string,
  ) {
    const actor = await this.login.resolveActor(sessionId, userId, guestToken);
    return this.login.start(actor, sessionId);
  }

  @ApiHeader({ name: 'x-onboarding-guest-token', required: false })
  @Post(':sessionId/login/credentials')
  async loginCredentials(
    @CurrentUser('id') userId: string | undefined,
    @Param('sessionId') sessionId: string,
    @Body() dto: CredentialLoginRequestDto,
    @Headers('x-onboarding-guest-token') guestToken?: string,
  ) {
    const actor = await this.login.resolveActor(sessionId, userId, guestToken);
    return this.login.credentialLogin(actor, sessionId, dto);
  }

  @Get(':sessionId/login/status')
  async loginStatus(
    @CurrentUser('id') userId: string | undefined,
    @Param('sessionId') sessionId: string,
    @Headers('x-onboarding-guest-token') guestToken?: string,
  ) {
    const actor = await this.login.resolveActor(sessionId, userId, guestToken);
    return this.login.status(actor, sessionId);
  }

  @Post(':sessionId/login/complete')
  async loginComplete(
    @CurrentUser('id') userId: string | undefined,
    @Param('sessionId') sessionId: string,
    @Headers('x-onboarding-guest-token') guestToken?: string,
  ) {
    const actor = await this.login.resolveActor(sessionId, userId, guestToken);
    return this.login.complete(actor, sessionId);
  }

  /** After portal session + profile scrape: create/link Course Rep user and issue JWT. */
  @Post(':sessionId/claim-identity')
  async claimIdentity(
    @CurrentUser('id') userId: string | undefined,
    @Param('sessionId') sessionId: string,
    @Headers('x-onboarding-guest-token') guestToken?: string,
  ) {
    const actor = await this.login.resolveActor(sessionId, userId, guestToken);
    return this.login.claimIdentity(actor, sessionId);
  }

  // Public: authenticated by the one-time HMAC bridge token, not JWT.
  @Public()
  @Post('login-bridge')
  loginBridge(@Body() dto: LoginBridgeRequestDto) {
    return this.login.bridge(dto);
  }

  @Post(':sessionId/discover-academics')
  async discoverAcademics(
    @CurrentUser('id') userId: string | undefined,
    @Param('sessionId') sessionId: string,
    @Headers('x-onboarding-guest-token') guestToken?: string,
  ) {
    const actor = await this.login.resolveActor(sessionId, userId, guestToken);
    return this.deepDiscovery.start(actor, sessionId);
  }

  @Get(':sessionId/discovery-results')
  async discoveryResults(
    @CurrentUser('id') userId: string | undefined,
    @Param('sessionId') sessionId: string,
    @Headers('x-onboarding-guest-token') guestToken?: string,
  ) {
    const actor = await this.login.resolveActor(sessionId, userId, guestToken);
    return this.deepDiscovery.results(actor, sessionId);
  }

  @Post(':sessionId/apply-results')
  async applyResults(
    @CurrentUser('id') userId: string | undefined,
    @Param('sessionId') sessionId: string,
    @Body() dto: ApplyResultsRequestDto,
    @Headers('x-onboarding-guest-token') guestToken?: string,
  ) {
    const actor = await this.login.resolveActor(sessionId, userId, guestToken);
    return this.deepDiscovery.applyResults(actor, sessionId, dto);
  }

  @Post(':sessionId/sync-to-course-rep')
  async syncToCourseRep(
    @CurrentUser('id') userId: string | undefined,
    @Param('sessionId') sessionId: string,
    @Body() dto: CourseImportSelectionDto,
    @Headers('x-onboarding-guest-token') guestToken?: string,
  ) {
    const actor = await this.login.resolveActor(sessionId, userId, guestToken);
    return this.sync.syncToCourseRep(actor, sessionId, dto);
  }
}
