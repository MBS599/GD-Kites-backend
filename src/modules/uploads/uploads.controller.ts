import { BadRequestException, Controller, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/auth.decorators';
import { imageUpload, publicUrl } from '../../common/uploads';
import { AppConfig } from '../../config/app-config.service';

@ApiTags('Uploads')
@ApiBearerAuth()
@Controller('uploads')
export class UploadsController {
  constructor(private readonly config: AppConfig) {}

  /** Product images (admin). Returns a public URL to store on the product. */
  @Roles('ADMIN')
  @Post()
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  @UseInterceptors(FileInterceptor('file', imageUpload))
  upload(@UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file was uploaded.');
    return { url: publicUrl(this.config.get('PUBLIC_BASE_URL'), file.filename) };
  }
}
