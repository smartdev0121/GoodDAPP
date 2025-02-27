import React from 'react'

import { t } from '@lingui/macro'
import ExplanationDialog from '../common/dialogs/ExplanationDialog'
import illustration from '../../assets/QRCamerraPermission.svg'

export default () => (
  <ExplanationDialog
    title={t`Please allow access to your camera`}
    text={t`In order to complete the QR code scan`}
    image={illustration}
  />
)

/*
 - Usage example

const { showDialog } = useDialog()

showDialog({
  content: <CameraPermissionDialogTypeQR />,
  isMinHeight: false,
  buttons: [
    {
      text: 'OK',
      onPress: dismiss => {
        // do something
        dismiss()
      },
    },
  ],
})
*/
